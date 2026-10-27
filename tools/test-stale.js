'use strict';
const puppeteer = require('puppeteer-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN || '/tmp/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PROFILE = '/tmp/vi2zh-stale-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const server = http.createServer((req, res) => {
    const file = req.url === '/' ? '/demo/index.html' : req.url.split('?')[0];
    const full = path.join(ROOT, decodeURIComponent(file));
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(full);
      const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      res.end(data);
    });
  }).listen(8899);
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-deepseek.js')], { stdio: 'ignore' });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      '--no-proxy-server',
      '--no-first-run',
      '--window-size=1400,900'
    ]
  });

  let sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('/src/background.js'), { timeout: 20000 });
  let worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.setViewport({ width: 1400, height: 900 });
  await page.goto('http://127.0.0.1:8899/demo/index.html', { waitUntil: 'networkidle2' });
  await sleep(800);

  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:8899/*' });
    return tabs[0].id;
  });
  await worker.evaluate(async (id) => {
    await chrome.storage.local.set({
      settings: { apiKey: 'sk-mock-1234567890', baseUrl: 'http://127.0.0.1:8787', model: 'deepseek-flash', batchSize: 24, concurrency: 4, maxRequests: 300, showOriginal: true, autoHosts: [], skipSelectors: '', glossaryText: '' }
    });
    await chrome.tabs.sendMessage(id, { type: 'VI2ZH_START' }, { frameId: 0 });
  }, tabId);
  await sleep(4000);

  // 模拟扩展被重新加载
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(2500);

  // 旧页面产生新文本，触发一次后台请求
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.id = 'stale-probe';
    div.textContent = 'Kiểm tra sau khi tải lại tiện ích';
    document.body.appendChild(div);
  });
  await sleep(2500);

  const hud = await page.evaluate(() => {
    const host = document.querySelector('[data-vi2zh="hud"]');
    return host && host.shadowRoot ? host.shadowRoot.textContent : '';
  });
  const probe = await page.evaluate(() => document.getElementById('stale-probe')?.textContent || '');

  console.log('HUD:', JSON.stringify(hud.slice(0, 120)));
  console.log('probe still vietnamese:', /Kiểm tra/.test(probe));
  console.log('pageerrors:', errors);
  console.log('console errors:', consoleErrors);
  const ok = /刷新页面/.test(hud) && !errors.some((e) => /invalidated/i.test(e)) && !consoleErrors.some((e) => /invalidated/i.test(e));
  console.log(ok ? 'STALE TEST PASS' : 'STALE TEST FAIL');
  await browser.close();
  server.close();
  mock.kill();
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
