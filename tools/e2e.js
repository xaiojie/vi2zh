#!/usr/bin/env node
/**
 * 端到端验证：真实 Chrome (Chrome for Testing) + 真实 MV3 扩展 + 本地 Mock DeepSeek。
 *   node tools/e2e.js
 * 依赖：puppeteer-core（devDependency），不会下载额外浏览器。
 * 产出：控制台 PASS/FAIL、screenshots/demo-vi.png、screenshots/demo-zh.png、
 *      screenshots/popup.png、/tmp/vi2zh-e2e.json
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME =
  process.env.CHROME_BIN ||
  '/tmp/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

if (!fs.existsSync(CHROME)) {
  console.error(
    `未找到 Chrome for Testing：${CHROME}\n` +
      '请下载 Chrome for Testing 并用 CHROME_BIN=/path/to/chrome 指定可执行文件。'
  );
  process.exit(2);
}
const WEB_PORT = 8788;
const MOCK_PORT = 8787;
const DEMO = `http://127.0.0.1:${WEB_PORT}/demo/index.html`;
const SHOTS = path.join(ROOT, 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);
const results = { steps: [], failures: [] };

function check(name, ok, detail) {
  results.steps.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
  if (!ok) results.failures.push({ name, detail });
}

/* ------------------------------------------------------------ 静态站点 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function startWebServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${WEB_PORT}`);
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (url.pathname === '/') file = path.join(ROOT, 'demo', 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(WEB_PORT, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------ 页面检查（在页面主世界执行） */

function inspectPage() {
  const VI = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
  const remaining = [];
  const attributeHits = [];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const walk = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(node.tagName)) return;
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (text.length > 1 && VI.test(text)) remaining.push(text.slice(0, 120));
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(document.documentElement);
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
      const v = el.getAttribute(attr);
      if (!v || !VI.test(v)) continue;
      // 扩展为“悬停看原文”写入的 title 是刻意保留的越南语，不算残留
      if (attr === 'title' && el.getAttribute('data-vi2zh-tip') === v) continue;
      attributeHits.push(`${el.tagName.toLowerCase()}[${attr}]=${v.slice(0, 60)}`);
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
      if (el.value && VI.test(el.value)) attributeHits.push(`input[value]=${el.value.slice(0, 60)}`);
    }
  });
  const note = document.querySelector('x-note-card');
  const hud = document.querySelector('[data-vi2zh="hud"]');
  return {
    href: location.href,
    title: document.title,
    remaining: remaining.slice(0, 20),
    remainingCount: remaining.length,
    attributeHits: attributeHits.slice(0, 20),
    attributeCount: attributeHits.length,
    shadowText: note?.shadowRoot ? note.shadowRoot.querySelector('h3')?.innerText || null : null,
    hudText: hud?.shadowRoot?.querySelector('.panel')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) || null,
    hasHd: document.body.innerText.includes('HD0001234'),
    bodySample: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200)
  };
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync('/tmp/vi2zh-e2e-profile', { recursive: true, force: true });

  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-deepseek.js'), String(MOCK_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`));
  const web = await startWebServer();

  let browser;
  try {
    log('launching Chrome for Testing…');
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      timeout: 30000,
      args: [
        '--user-data-dir=/tmp/vi2zh-e2e-profile',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--window-size=1440,1000',
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        '--no-proxy-server'
      ]
    });

    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('/src/background.js'),
      { timeout: 20000 }
    );
    const extId = new URL(swTarget.url()).host;
    const worker = await swTarget.worker();
    log('extension id:', extId);
    check('扩展 service worker 启动', true, swTarget.url());
    check('manifest 可读', (await worker.evaluate(() => chrome.runtime.getManifest().name)).includes('越译中'));

    const settings = {
      apiKey: 'sk-mock-1234567890',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      model: 'deepseek-flash',
      batchSize: 24,
      concurrency: 4,
      maxRequests: 300,
      showOriginal: true,
      autoHosts: [],
      skipSelectors: '',
      glossaryText: ''
    };
    await worker.evaluate(async (s) => {
      await chrome.storage.local.set({ settings: s });
      await chrome.storage.local.remove(['trCache', 'usage', 'trStats']);
      return true;
    }, settings);

    log('opening demo page…');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
    await page.goto(DEMO, { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(1200);
    check('demo 页面加载', (await page.title()).includes('MISA ASP'), await page.title());
    await page.screenshot({ path: path.join(SHOTS, 'demo-vi.png'), fullPage: true });

    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.startsWith('http://127.0.0.1:8788'));
      return t && t.id;
    });
    check('找到 demo 标签页', typeof tabId === 'number', tabId);

    const msg = (payload) =>
      worker.evaluate(
        async (id, p) => {
          try {
            return await chrome.tabs.sendMessage(id, p, { frameId: 0 });
          } catch (e) {
            return 'ERR:' + e.message;
          }
        },
        tabId,
        payload
      );

    let started = null;
    for (let i = 0; i < 10; i++) {
      started = await msg({ type: 'VI2ZH_START' });
      if (started && started !== 'ERR:') break;
      await sleep(500);
    }
    check('内容脚本接收 START', started && started.ok, started);

    let stats = null;
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      stats = await msg({ type: 'VI2ZH_STATUS' });
      if (
        stats &&
        typeof stats === 'object' &&
        !stats.running &&
        stats.total >= 100 &&
        stats.translated + stats.failed >= stats.total
      ) break;
      await sleep(400);
    }
    log('stats:', JSON.stringify(stats), `elapsed=${Date.now() - t0}ms`);
    check('翻译完成且无失败', stats && stats.running === false && stats.translated > 20 && stats.failed === 0, stats);
    check('站点类型自动识别为财务会计', stats && stats.siteType === 'accounting', stats && stats.siteType);

    // 懒加载 iframe：滚到底触发加载，再等所有帧真正翻译完（含后注入帧）
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let i = 0; i < 40; i++) {
      let dirty = 0;
      for (const f of page.frames()) {
        try {
          const r = await f.evaluate(inspectPage);
          if (r.remainingCount > 0 || r.attributeCount > 0) dirty += 1;
        } catch {
          dirty += 1;
        }
      }
      if (!dirty) break;
      await sleep(400);
    }

    const mockState1 = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/state`)).json();
    check('Mock 收到批量请求', mockState1.calls > 0, {
      calls: mockState1.calls,
      texts: mockState1.texts,
      batches: mockState1.batches.map((b) => b.count)
    });
    check('演示页词汇全部命中词典', mockState1.unmatched.length === 0, mockState1.unmatched);
    check('按站点类型注入领域提示词', /财务会计/.test(mockState1.systemPrompt || ''), (mockState1.systemPrompt || '').slice(0, 120));

    // 主文档 + iframe 逐帧检查
    const frames = page.frames();
    log('frames:', frames.length);
    const inspected = [];
    for (const frame of frames) {
      try {
        const r = await frame.evaluate(inspectPage);
        inspected.push({ url: frame.url(), ...r });
        const p = new URL(frame.url()).pathname;
        check(`frame 无残留越南语文本 (${p})`, r.remainingCount === 0, r.remaining);
        check(`frame 属性全部翻译 (${p})`, r.attributeCount === 0, r.attributeHits);
      } catch (e) {
        check(`frame 可检查 (${frame.url()})`, false, String(e.message));
      }
    }
    const main = inspected[0] || {};
    check('标题已翻译', /工作台/.test(main.title || ''), main.title);
    check('Shadow DOM 已翻译', /快速备注/.test(main.shadowText || ''), main.shadowText);
    check('数字/单号未被翻译', main.hasHd === true);
    check('HUD 已显示进度', /译|还原/.test(main.hudText || ''), main.hudText);
    check(
      'iframe 文本已翻译',
      inspected.some((f) => /缴款人|收款单/.test(f.bodySample || '')),
      inspected.map((f) => f.bodySample)
    );

    // 移除实时时钟，停止制造新文本，让 HUD 自动淡出，截图更干净
    await page.evaluate(() => document.getElementById('clock')?.remove());
    await sleep(6000);
    await page.screenshot({ path: path.join(SHOTS, 'demo-zh.png'), fullPage: true });
    log('saved screenshots/demo-zh.png');

    // 动态内容：新增一行（React 式重渲染）
    const callsBefore = mockState1.calls;
    await page.evaluate(() => document.getElementById('addRow').click());
    await sleep(4000);
    const afterAdd = await page.evaluate(inspectPage);
    check('动态新增行被翻译', afterAdd.remainingCount === 0, afterAdd.remaining.slice(0, 6));
    const mockState2 = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/state`)).json();
    check('动态内容已处理', mockState2.calls >= callsBefore, { before: callsBefore, after: mockState2.calls });

    // 还原
    await msg({ type: 'VI2ZH_RESTORE' });
    await sleep(1500);
    const restored = await page.evaluate(
      () => document.body.innerText.includes('Tổng quan') && document.body.innerText.includes('Nghiệp vụ thường dùng')
    );
    check('还原为越南语原文', restored === true);
    check('还原后 HUD 移除', (await page.evaluate(() => !document.querySelector('[data-vi2zh-hud]'))) === true);

    // 再次翻译：应全部命中本地缓存
    const cacheStateBefore = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/state`)).json();
    const cacheSnapshot = cacheStateBefore.seen;
    const callsBeforeCache = cacheStateBefore.calls;
    const again = await msg({ type: 'VI2ZH_START' });
    check('再次启动接受', again && again.ok, again);
    for (let i = 0; i < 100; i++) {
      stats = await msg({ type: 'VI2ZH_STATUS' });
      if (stats && typeof stats === 'object' && !stats.running && stats.translated > 0) break;
      await sleep(300);
    }
    await sleep(1200);
    const stateAfterCache = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/state`)).json();
    const seenBefore = new Set(cacheSnapshot);
    const freshTexts = stateAfterCache.seen.filter((t) => !seenBefore.has(t));
    log('new texts after cache run:', JSON.stringify(freshTexts));
    check(
      '缓存命中：二次翻译零新增请求',
      freshTexts.length === 0 && stateAfterCache.calls === callsBeforeCache,
      { before: callsBeforeCache, after: stateAfterCache.calls, freshTexts }
    );

    // 跨页面刷新：应直接命中本地缓存，不再产生 API 请求
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => document.getElementById('clock')?.remove());
    await sleep(800);
    const reloadState = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/state`)).json();
    const callsBeforeReloadStart = reloadState.calls;
    const reloadStart = await msg({ type: 'VI2ZH_START' });
    check('刷新后再次启动接受', reloadStart && reloadStart.ok, reloadStart);
    let reloadedZh = false;
    for (let i = 0; i < 80; i++) {
      reloadedZh = await page.evaluate(
        () => document.body.innerText.includes('工作台') && document.body.innerText.includes('总览')
      );
      if (reloadedZh) break;
      await sleep(250);
    }
    await sleep(1500);
    const afterReload = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/state`)).json();
    check('刷新页面后自动套用缓存译文', reloadedZh === true);
    check('刷新页面后未再请求 API', afterReload.calls === callsBeforeReloadStart, {
      before: callsBeforeReloadStart,
      after: afterReload.calls
    });
    const cacheCount = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('trCache');
      return Object.keys(stored.trCache || {}).length;
    });
    check('译文已持久化到本地缓存', cacheCount >= 100, cacheCount);

    // 弹窗界面截图
    const popup = await browser.newPage();
    await popup.setViewport({ width: 400, height: 660, deviceScaleFactor: 2 });
    await popup.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle2', timeout: 15000 });
    // 让 demo 页成为活动标签，弹窗才能读到真实页面状态
    await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), tabId);
    await popup.reload({ waitUntil: 'networkidle2' });
    await sleep(1800);
    const popupHeight = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await popup.setViewport({ width: 400, height: Math.max(360, popupHeight), deviceScaleFactor: 2 });
    await sleep(300);
    await popup.screenshot({ path: path.join(SHOTS, 'popup.png') });
    log('saved screenshots/popup.png');
    const popupVersion = await popup.evaluate(() => document.getElementById('version')?.textContent || '');
    const manifestVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
    check('弹窗版本号与 manifest 一致', popupVersion === `v${manifestVersion}`, popupVersion);

    const popupInfo = await popup.evaluate(() => ({
      buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
      status: document.getElementById('statusText')?.textContent,
      siteType: document.getElementById('siteTypeText')?.textContent || '',
      usage: document.getElementById('usageText')?.textContent || '',
      cost: document.getElementById('costText')?.textContent || '',
      hasKey: document.getElementById('apiKey')?.value?.length > 0
    }));
    check('弹窗页面渲染 + 设置已加载', popupInfo.buttons.length >= 3 && popupInfo.hasKey, popupInfo);
    check('弹窗显示缓存用量信息', /缓存|请求/.test(popupInfo.usage), popupInfo.usage);
    check('弹窗显示站点类型', /站点类型：财务会计/.test(popupInfo.siteType), popupInfo.siteType);
    check('弹窗显示人民币费用', /今日 ¥[\d.]+ · 累计 ¥[\d.]+/.test(popupInfo.cost), popupInfo.cost);

    const periods = await worker.evaluate(() => {
      const at = (iso) => VI2ZH_PRICING.isPeak(new Date(iso));
      return {
        holiday: at('2026-10-01T10:00:00+08:00'),
        workday: at('2026-10-21T10:00:00+08:00'),
        weekend: at('2026-10-24T10:00:00+08:00'),
        lunch: at('2026-10-21T12:30:00+08:00'),
        night: at('2026-10-21T23:00:00+08:00')
      };
    });
    check(
      '峰谷判断含法定节假日',
      periods.holiday === false && periods.workday === true && periods.weekend === false &&
        periods.lunch === false && periods.night === false,
      periods
    );

    const usage = await worker.evaluate(async () => (await chrome.storage.local.get('usage')).usage || null);
    log('usage:', JSON.stringify(usage));
    check(
      '费用与缓存 token 已入账',
      usage && usage.costCNY > 0 && usage.cacheHitTokens > 0 && usage.cacheMissTokens > 0,
      usage && { costCNY: usage.costCNY, hit: usage.cacheHitTokens, miss: usage.cacheMissTokens }
    );
    await popup.evaluate(() => document.getElementById('btnTest').click());
    await sleep(1500);
    const testNotice = await popup.evaluate(() => document.getElementById('settingsNotice').textContent);
    check('弹窗测试连接成功', /连接成功/.test(testNotice), testNotice);

    await popup.evaluate(() => document.getElementById('btnBalance').click());
    await sleep(1200);
    const balanceNotice = await popup.evaluate(() => document.getElementById('settingsNotice').textContent);
    check('弹窗可查询账户余额', /余额 ¥88\.88/.test(balanceNotice), balanceNotice);

    await popup.evaluate(() => {
      const box = document.getElementById('autoSite');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(600);
    const autoHosts = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('settings');
      return (stored.settings || {}).autoHosts || [];
    });
    check('自动翻译站点已写入设置', autoHosts.includes('127.0.0.1'), autoHosts);

    check('背景统计已记录', usage && usage.requests > 0, usage);
    check('页面无 JS 异常', consoleErrors.length === 0, consoleErrors.slice(0, 5));

    await popup.close();
    await page.close();
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    mock.kill('SIGKILL');
    web.close();
    fs.writeFileSync('/tmp/vi2zh-e2e.json', JSON.stringify(results, null, 2));
    console.log(
      `\n[e2e] ${results.failures.length === 0 ? 'ALL PASS' : results.failures.length + ' FAILURE(S)'} → /tmp/vi2zh-e2e.json`
    );
    if (results.failures.length) {
      console.log(JSON.stringify(results.failures, null, 2));
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  fs.writeFileSync('/tmp/vi2zh-e2e.json', JSON.stringify({ ...results, fatal: String(err.stack || err) }, null, 2));
  process.exitCode = 1;
});
