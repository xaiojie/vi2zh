'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULTS = globalThis.VI2ZH_DEFAULTS;
const SITES = globalThis.VI2ZH_SITES;
const PRICING = globalThis.VI2ZH_PRICING;

let settings = { ...DEFAULTS };
let usage = null;
let currentHost = '';

const MODEL_VALUES = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
const LANGS = [
  ['auto', '自动识别'], ['vi', '越南语'], ['en', '英语'], ['zh', '中文'],
  ['th', '泰语'], ['id', '印尼语'], ['ja', '日语'], ['ko', '韩语'], ['lo', '老挝语'], ['km', '高棉语']
];

/* ---------------------------------------------------------------- */
/* 基础工具                                                          */
/* ---------------------------------------------------------------- */

function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}

function formatMoney(value) {
  const number = Number(value) || 0;
  if (!number) return '¥0.0000';
  if (number < 0.01) return `¥${number.toFixed(4)}`;
  return `¥${number.toFixed(2)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(Number(value) || 0));
}

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function saveSettings(next, { quiet = false } = {}) {
  settings = { ...settings, ...next };
  await chrome.storage.local.set({ settings });
  if (settings.syncEnabled) {
    const { apiKey, ...safe } = settings;
    await chrome.storage.sync.set({ vi2zhSettings: safe, vi2zhSettingsAt: Date.now() }).catch(() => {});
  }
  if (!quiet) {
    $('saveState').textContent = '已保存';
    toast('设置已保存');
  }
}

function parseGlossary(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf('=');
      if (index <= 0) return null;
      return { source: line.slice(0, index).trim(), target: line.slice(index + 1).trim() };
    })
    .filter(Boolean);
}

function glossaryToText(pairs) {
  return pairs.map((pair) => `${pair.source}=${pair.target}`).join('\n');
}

/* ---------------------------------------------------------------- */
/* 通用设置                                                          */
/* ---------------------------------------------------------------- */

function fillSiteTypeOptions() {
  for (const id of ['ruleSiteType']) {
    const select = $(id);
    select.innerHTML = '<option value="">跟随全局</option><option value="auto">自动识别</option>';
    for (const key of SITES.ORDER) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = SITES.PROFILES[key].label;
      select.appendChild(option);
    }
  }
}

async function ensureHostPermission(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (['api.deepseek.com', 'localhost', '127.0.0.1'].includes(url.hostname)) return true;
  const origin = `${url.protocol}//${url.hostname}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

function fillGeneral() {
  $('apiKey').value = settings.apiKey || '';
  $('baseUrl').value = settings.baseUrl || DEFAULTS.baseUrl;
  $('mode').value = settings.mode === 'bilingual' ? 'bilingual' : 'replace';
  $('modelMode').value = settings.modelMode === 'auto' ? 'auto' : 'fixed';
  $('model').value = MODEL_VALUES.includes(settings.model) ? settings.model : DEFAULTS.model;
  $('sourceLang').value = LANGS.some(([code]) => code === settings.sourceLang) ? settings.sourceLang : 'auto';
  $('targetLang').value = ['zh', 'vi', 'en'].includes(settings.targetLang) ? settings.targetLang : 'zh';
  $('batchSize').value = String(settings.batchSize);
  $('concurrency').value = String(settings.concurrency);
  $('maxRequests').value = String(settings.maxRequests);
  $('skipSelectors').value = settings.skipSelectors || '';
  $('selectionTranslate').checked = settings.selectionTranslate !== false;
  $('inputTranslate').checked = settings.inputTranslate !== false;
  $('showOriginal').checked = settings.showOriginal !== false;
  $('respectNoTranslate').checked = settings.respectNoTranslate === true;
  $('privacyMode').checked = settings.privacyMode === true;
  $('budgetDaily').value = String(settings.budgetDaily || 0);
  $('budgetMonthly').value = String(settings.budgetMonthly || 0);
  $('syncEnabled').checked = settings.syncEnabled === true;
}

function collectGeneral() {
  return {
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    mode: $('mode').value === 'bilingual' ? 'bilingual' : 'replace',
    modelMode: $('modelMode').value === 'auto' ? 'auto' : 'fixed',
    model: MODEL_VALUES.includes($('model').value) ? $('model').value : DEFAULTS.model,
    sourceLang: $('sourceLang').value,
    targetLang: $('targetLang').value,
    batchSize: Math.min(40, Math.max(4, Number($('batchSize').value) || DEFAULTS.batchSize)),
    concurrency: Math.min(8, Math.max(1, Number($('concurrency').value) || DEFAULTS.concurrency)),
    maxRequests: Math.min(2000, Math.max(20, Number($('maxRequests').value) || DEFAULTS.maxRequests)),
    skipSelectors: $('skipSelectors').value.trim(),
    selectionTranslate: $('selectionTranslate').checked,
    inputTranslate: $('inputTranslate').checked,
    showOriginal: $('showOriginal').checked,
    respectNoTranslate: $('respectNoTranslate').checked,
    privacyMode: $('privacyMode').checked,
    budgetDaily: Math.max(0, Number($('budgetDaily').value) || 0),
    budgetMonthly: Math.max(0, Number($('budgetMonthly').value) || 0),
    syncEnabled: $('syncEnabled').checked
  };
}

/* ---------------------------------------------------------------- */
/* 站点规则                                                          */
/* ---------------------------------------------------------------- */

function renderRules() {
  const list = $('ruleList');
  const rules = settings.siteRules || {};
  const hosts = Object.keys(rules).sort();
  list.innerHTML = '';
  if (!hosts.length) {
    list.innerHTML = '<p class="help">还没有站点规则。上面的表单可以按域名添加。</p>';
    return;
  }
  for (const host of hosts) {
    const rule = rules[host];
    const row = document.createElement('div');
    row.className = 'list-row';
    const tags = [
      rule.auto ? '自动翻译' : '',
      rule.disabled ? '已禁用' : '',
      rule.mode ? (rule.mode === 'bilingual' ? '双语' : '替换') : '',
      rule.siteType && rule.siteType !== 'auto' ? SITES.resolve(rule.siteType).label : ''
    ].filter(Boolean);
    row.innerHTML = `<div class="list-main"><strong></strong><span class="tags"></span></div>
      <div class="list-actions"><button class="mini edit">编辑</button><button class="mini del">删除</button></div>`;
    row.querySelector('strong').textContent = host;
    row.querySelector('.tags').textContent = tags.join(' · ') || '继承全局';
    row.querySelector('.edit').addEventListener('click', () => loadRule(host));
    row.querySelector('.del').addEventListener('click', async () => {
      delete settings.siteRules[host];
      await saveSettings({ siteRules: settings.siteRules });
      renderRules();
    });
    list.appendChild(row);
  }
}

function loadRule(host) {
  const rule = (settings.siteRules || {})[host] || {};
  $('ruleHost').value = host;
  $('ruleSiteType').value = rule.siteType || '';
  $('ruleMode').value = rule.mode || '';
  $('ruleSkip').value = rule.skipSelectors || '';
  $('ruleGlossary').value = rule.glossaryText || '';
  $('ruleAuto').checked = !!rule.auto;
  $('ruleDisabled').checked = !!rule.disabled;
}

function saveRule() {
  const host = $('ruleHost').value.trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) {
    toast('请填写有效的域名，例如 actasp.misa.vn', 'warn');
    return;
  }
  const rule = {
    siteType: $('ruleSiteType').value || '',
    mode: $('ruleMode').value || '',
    skipSelectors: $('ruleSkip').value.trim(),
    glossaryText: $('ruleGlossary').value.trim(),
    auto: $('ruleAuto').checked,
    disabled: $('ruleDisabled').checked
  };
  settings.siteRules = { ...(settings.siteRules || {}), [host]: rule };
  saveSettings({ siteRules: settings.siteRules });
  renderRules();
  toast(`已保存 ${host} 的规则`);
}

/* ---------------------------------------------------------------- */
/* 术语表                                                            */
/* ---------------------------------------------------------------- */

function renderGlossary() {
  const pairs = parseGlossary(settings.glossaryText);
  const list = $('glossaryList');
  list.innerHTML = '';
  pairs.forEach((pair, index) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = '<div class="list-main"><strong></strong><span class="muted"></span></div><button class="mini del">删除</button>';
    row.querySelector('strong').textContent = pair.source;
    row.querySelector('.muted').textContent = pair.target;
    row.querySelector('.del').addEventListener('click', async () => {
      pairs.splice(index, 1);
      settings.glossaryText = glossaryToText(pairs);
      await saveSettings({ glossaryText: settings.glossaryText });
      renderGlossary();
    });
    list.appendChild(row);
  });
  $('glossaryCount').textContent = pairs.length ? `共 ${pairs.length} 条术语` : '还没有自定义术语';
}

async function addTerm() {
  const source = $('glossarySource').value.trim();
  const target = $('glossaryTarget').value.trim();
  if (!source || !target) return toast('请填写原文与译文', 'warn');
  const pairs = parseGlossary(settings.glossaryText);
  if (pairs.some((pair) => pair.source.toLowerCase() === source.toLowerCase())) {
    return toast('这个术语已经存在', 'warn');
  }
  pairs.push({ source, target });
  settings.glossaryText = glossaryToText(pairs);
  await saveSettings({ glossaryText: settings.glossaryText });
  $('glossarySource').value = '';
  $('glossaryTarget').value = '';
  renderGlossary();
}

/* ---------------------------------------------------------------- */
/* 用量与预算                                                        */
/* ---------------------------------------------------------------- */

async function refreshUsage() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_GET_USAGE' });
    usage = response && response.usage;
    renderUsage(response || {});
  } catch {
    toast('读取用量失败，请重新加载扩展', 'warn');
  }
}

function monthCost() {
  if (!usage || !usage.daily) return 0;
  const prefix = PRICING.beijingDate().slice(0, 7);
  return Object.entries(usage.daily)
    .filter(([date]) => date.startsWith(prefix))
    .reduce((sum, [, item]) => sum + (Number(item.costCNY) || 0), 0);
}

function renderUsage(response) {
  const todayKey = PRICING.beijingDate();
  const today = usage && usage.daily && usage.daily[todayKey] ? usage.daily[todayKey] : { requests: 0, costCNY: 0 };
  $('todayCost').textContent = formatMoney(today.costCNY);
  $('monthCost').textContent = formatMoney(monthCost());
  $('totalRequests').textContent = formatNumber(usage ? usage.requests : 0);
  $('totalTokens').textContent = formatTokens((usage ? usage.promptTokens + usage.completionTokens : 0));
  $('periodHint').textContent = response.period
    ? `当前计费时段：${response.period.label} · ${response.period.until || response.period.reason}`
    : '按 DeepSeek 官方峰谷价估算';

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000);
    const key = PRICING.beijingDate(date);
    const item = usage && usage.daily && usage.daily[key] ? usage.daily[key] : { costCNY: 0 };
    days.push({ key, cost: Number(item.costCNY) || 0 });
  }
  const max = Math.max(0.0001, ...days.map((day) => day.cost));
  $('chart').innerHTML = days.map((day) => {
    const height = Math.max(2, Math.round((day.cost / max) * 100));
    return `<div class="bar" title="${day.key} · ${formatMoney(day.cost)}">
      <div class="bar-fill" style="height:${height}%"></div><span>${day.key.slice(5)}</span></div>`;
  }).join('');

  const dailyBudget = Number(settings.budgetDaily) || 0;
  const monthlyBudget = Number(settings.budgetMonthly) || 0;
  const parts = [];
  if (dailyBudget) parts.push(`今日 ${formatMoney(today.costCNY)} / 预算 ${formatMoney(dailyBudget)}`);
  if (monthlyBudget) parts.push(`本月 ${formatMoney(monthCost())} / 预算 ${formatMoney(monthlyBudget)}`);
  $('budgetHint').textContent = parts.join(' · ') || '未设置预算上限';
}

async function checkBalance() {
  const button = $('btnBalance');
  button.disabled = true;
  $('costNotice').textContent = '查询中…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_BALANCE' });
    if (response && response.ok) {
      $('costNotice').textContent = `账户余额 ¥${response.total} · 赠送 ¥${response.granted} · 充值 ¥${response.toppedUp}`;
    } else {
      $('costNotice').textContent = (response && response.error) || '查询失败';
    }
  } finally {
    button.disabled = false;
  }
}

async function clearCache() {
  const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_CLEAR_CACHE' });
  toast(`已清空 ${response.cleared || 0} 条缓存`);
  refreshUsage();
}

/* ---------------------------------------------------------------- */
/* 更新 / 同步 / 导入导出                                            */
/* ---------------------------------------------------------------- */

async function autoCheckUpdate() {
  try {
    const stored = await chrome.storage.local.get('lastUpdateCheck');
    if (Date.now() - (stored.lastUpdateCheck || 0) < 86400000) return;
    await chrome.storage.local.set({ lastUpdateCheck: Date.now() });
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_CHECK_UPDATE' });
    if (response && response.ok && response.newer) {
      const banner = $('updateBanner');
      banner.hidden = false;
      banner.innerHTML = `发现新版本 <strong>v${response.latest}</strong>（当前 v${response.current}）`;
      const link = document.createElement('a');
      link.href = response.url;
      link.target = '_blank';
      link.textContent = '查看更新';
      banner.appendChild(link);
    }
  } catch {
    /* 离线或 GitHub 限流时静默 */
  }
}

async function renderFeedback() {
  const stored = await chrome.storage.local.get('feedback');
  const list = Array.isArray(stored.feedback) ? stored.feedback : [];
  const box = $('feedbackList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="help">还没有反馈记录。</p>';
    return;
  }
  const head = document.createElement('p');
  head.className = 'help';
  head.textContent = `共 ${list.length} 条`;
  box.appendChild(head);
  for (const item of list.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const main = document.createElement('div');
    main.className = 'list-main';
    const strong = document.createElement('strong');
    strong.textContent = `${item.text || ''} → ${item.translation || ''}`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${item.site || '未知站点'} · ${new Date(item.at).toLocaleString()}`;
    main.appendChild(strong);
    main.appendChild(meta);
    row.appendChild(main);
    box.appendChild(row);
  }
}

async function checkUpdate() {
  const button = $('btnCheckUpdate');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_CHECK_UPDATE' });
    const banner = $('updateBanner');
    if (response && response.ok) {
      if (response.newer) {
        banner.hidden = false;
        banner.innerHTML = `发现新版本 <strong>v${response.latest}</strong>（当前 v${response.current}）`;
        const link = document.createElement('a');
        link.href = response.url;
        link.target = '_blank';
        link.textContent = '查看更新';
        banner.appendChild(link);
      } else {
        banner.hidden = false;
        banner.textContent = `已是最新版本 v${response.current}`;
        setTimeout(() => { banner.hidden = true; }, 3000);
      }
    } else {
      toast((response && response.error) || '检查更新失败', 'warn');
    }
  } finally {
    button.disabled = false;
  }
}

async function syncUpload() {
  const { apiKey, ...safe } = settings;
  try {
    await chrome.storage.sync.set({ vi2zhSettings: safe, vi2zhSettingsAt: Date.now() });
    $('syncHint').textContent = `已上传（${new Date().toLocaleString()}），不含 API Key`;
  } catch (err) {
    $('syncHint').textContent = `上传失败：${err.message || err}`;
  }
}

async function syncPull() {
  const stored = await chrome.storage.sync.get(['vi2zhSettings', 'vi2zhSettingsAt']);
  if (!stored.vi2zhSettings) {
    $('syncHint').textContent = '云端还没有设置';
    return;
  }
  settings = { ...DEFAULTS, ...stored.vi2zhSettings, apiKey: settings.apiKey };
  await chrome.storage.local.set({ settings });
  fillGeneral();
  renderGlossary();
  renderRules();
  refreshUsage();
  $('syncHint').textContent = `已从云端恢复（${stored.vi2zhSettingsAt ? new Date(stored.vi2zhSettingsAt).toLocaleString() : '时间未知'}）`;
}

function exportSettings() {
  const { apiKey, ...safe } = settings;
  const payload = { version: 1, exportedAt: new Date().toISOString(), settings: safe, usage };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vi2zh-settings-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importSettings(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const incoming = data.settings || data;
  settings = { ...settings, ...incoming, apiKey: settings.apiKey };
  await saveSettings({}, { quiet: true });
  fillGeneral();
  renderGlossary();
  renderRules();
  refreshUsage();
  toast('设置已导入');
}

/* ---------------------------------------------------------------- */
/* 初始化                                                            */
/* ---------------------------------------------------------------- */

function bind() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tab.dataset.tab}`));
      if (tab.dataset.tab === 'cost') refreshUsage();
    });
  });

  $('btnSaveAll').addEventListener('click', async () => {
    const next = collectGeneral();
    if (!(await ensureHostPermission(next.baseUrl))) {
      toast('未获得该接口域名的访问权限', 'warn');
      return;
    }
    await saveSettings(next);
    fillGeneral();
    refreshUsage();
  });

  $('btnTestConn').addEventListener('click', async () => {
    const next = collectGeneral();
    if (!next.apiKey) return toast('请先填写 API Key', 'warn');
    if (!(await ensureHostPermission(next.baseUrl))) return toast('未获得该接口域名的访问权限', 'warn');
    $('testHint').textContent = '测试中…';
    const response = await chrome.runtime.sendMessage({
      type: 'VI2ZH_TEST',
      settings: { ...next, model: $('model').value }
    });
    $('testHint').textContent = response && response.ok
      ? `连接成功（${response.latencyMs} ms），模型：${response.model}`
      : (response && response.error) || '连接失败';
  });

  $('btnSaveRule').addEventListener('click', saveRule);
  $('btnDetectSite').addEventListener('click', async () => {
    const host = $('ruleHost').value.trim();
    const tab = await activeTab();
    const detected = SITES.detect({
      host: host || currentHost,
      title: tab ? tab.title : '',
      sample: tab ? tab.url : ''
    });
    $('ruleSiteType').value = detected.id;
    $('detectHint').textContent = `识别结果：${detected.label}（${detected.confidence}，来源 ${detected.source}）`;
  });

  $('ruleHost').addEventListener('change', () => {
    const host = $('ruleHost').value.trim().toLowerCase();
    if (host && (settings.siteRules || {})[host]) loadRule(host);
  });

  $('btnAddTerm').addEventListener('click', addTerm);
  $('glossarySource').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addTerm();
  });
  $('glossaryTarget').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addTerm();
  });

  $('btnRefreshUsage').addEventListener('click', refreshUsage);
  $('btnBalance').addEventListener('click', checkBalance);
  $('btnClearCache').addEventListener('click', clearCache);
  $('btnCheckUpdate').addEventListener('click', checkUpdate);
  $('btnClearFeedback').addEventListener('click', async () => {
    await chrome.storage.local.remove('feedback');
    renderFeedback();
    toast('反馈记录已清空');
  });
  $('btnClose').addEventListener('click', () => window.close());
  $('btnSyncUpload').addEventListener('click', syncUpload);
  $('btnSyncPull').addEventListener('click', syncPull);
  $('btnExport').addEventListener('click', exportSettings);
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await importSettings(file);
    } catch (err) {
      toast(`导入失败：${err.message || err}`, 'warn');
    }
    event.target.value = '';
  });
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function init() {
  settings = await getSettings();
  try {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    /* ignore */
  }
  fillSiteTypeOptions();
  fillGeneral();
  renderRules();
  renderGlossary();

  const tab = await activeTab();
  if (tab && /^https?:/i.test(tab.url || '')) {
    try {
      currentHost = new URL(tab.url).hostname;
    } catch {
      currentHost = '';
    }
  }
  $('currentHost').textContent = currentHost || '（当前不是网页）';
  $('ruleHost').value = currentHost;

  bind();
  refreshUsage();
  renderFeedback();
  autoCheckUpdate();
}

init();
