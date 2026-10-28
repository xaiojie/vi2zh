/* 越译中 · 弹窗逻辑 */
'use strict';

const DEFAULTS = globalThis.VI2ZH_DEFAULTS;
const $ = (id) => document.getElementById(id);

let currentTab = null;
let settings = { ...DEFAULTS };
let pollTimer = 0;
let busy = false;

/* ---------------------------------------------------------------- */
/* 基础设施                                                          */
/* ---------------------------------------------------------------- */

function isSupportedUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

async function storageGetSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(stored.settings || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function storageSetSettings(next) {
  await chrome.storage.local.set({ settings: next });
}

function showNotice(el, message, kind = 'info') {
  if (!el) return;
  el.hidden = false;
  el.className = `notice ${kind}`;
  el.textContent = message;
}

function hideNotice(el) {
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

const MODEL_VALUES = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
const SITE_VALUES = ['auto', 'generic', 'accounting', 'ecommerce', 'hr', 'news', 'education'];

function formatMoney(value) {
  const number = Number(value) || 0;
  if (!number) return '0.00';
  if (number < 0.01) return number.toFixed(4);
  if (number < 1) return number.toFixed(3);
  return number.toFixed(2);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/* ---------------------------------------------------------------- */
/* 表单                                                              */
/* ---------------------------------------------------------------- */

function fillForm(next) {
  $('modeSelect').value = next.mode === 'bilingual' ? 'bilingual' : 'replace';
  $('apiKey').value = next.apiKey || '';
  $('baseUrl').value = next.baseUrl || DEFAULTS.baseUrl;
  $('model').value = MODEL_VALUES.includes(next.model) ? next.model : DEFAULTS.model;
  $('siteType').value = SITE_VALUES.includes(next.siteType) ? next.siteType : 'auto';
  $('batchSize').value = String(next.batchSize || DEFAULTS.batchSize);
  $('concurrency').value = String(next.concurrency || DEFAULTS.concurrency);
  $('maxRequests').value = String(next.maxRequests || DEFAULTS.maxRequests);
  $('showOriginal').checked = next.showOriginal !== false;
  $('respectNoTranslate').checked = next.respectNoTranslate === true;
  $('glossaryText').value = next.glossaryText || '';
  $('skipSelectors').value = next.skipSelectors || '';
}

function collectForm() {
  return {
    ...DEFAULTS,
    ...(settings || {}),
    mode: $('modeSelect').value === 'bilingual' ? 'bilingual' : 'replace',
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.baseUrl,
    model: MODEL_VALUES.includes($('model').value) ? $('model').value : DEFAULTS.model,
    siteType: SITE_VALUES.includes($('siteType').value) ? $('siteType').value : 'auto',
    batchSize: clampNumber($('batchSize').value, 4, 40, DEFAULTS.batchSize),
    concurrency: clampNumber($('concurrency').value, 1, 8, DEFAULTS.concurrency),
    maxRequests: clampNumber($('maxRequests').value, 20, 2000, DEFAULTS.maxRequests),
    showOriginal: $('showOriginal').checked,
    respectNoTranslate: $('respectNoTranslate').checked,
    glossaryText: $('glossaryText').value,
    skipSelectors: $('skipSelectors').value.trim(),
    autoHosts: Array.isArray(settings.autoHosts) ? settings.autoHosts : []
  };
}

function validateForm(next) {
  if (!next.apiKey) return '请填写 DeepSeek API Key。';
  if (!/^https:\/\/[^\s]+$/i.test(next.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(next.baseUrl)) {
    return '接口地址必须是 https 地址，或 http://localhost / http://127.0.0.1。';
  }
  return '';
}

/* ---------------------------------------------------------------- */
/* 权限：自定义接口地址                                              */
/* ---------------------------------------------------------------- */

async function ensureHostPermission(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (url.hostname === 'api.deepseek.com' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return true;
  }
  const origin = `${url.protocol}//${url.hostname}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- */
/* 标签页 / 内容脚本                                                  */
/* ---------------------------------------------------------------- */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

const CONTENT_FILES = [
  'src/shared/platform.js',
  'src/shared/defaults.js',
  'src/shared/lang.js',
  'src/shared/sites.js',
  'src/content.js'
];

async function pingTab(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'VI2ZH_PING' }, { frameId: 0 });
    return !!(pong && pong.ok);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await pingTab(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
  } catch (err) {
    console.warn('[越译中] 注入内容脚本失败', err);
    return false;
  }
  // 注入成功不代表监听已就绪，再确认一次，避免把英文底层错误直接抛给用户
  for (let i = 0; i < 6; i++) {
    if (await pingTab(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function sendToTab(type) {
  if (!currentTab) return { ok: false, error: '没有活动标签页' };
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { type }, { frameId: 0 });
    return response || { ok: false, error: '页面没有响应，请刷新后重试。' };
  } catch {
    // 常见于扩展更新后旧页面未刷新：重新注入一次再试
    if (await ensureContentScript(currentTab.id)) {
      try {
        const retry = await chrome.tabs.sendMessage(currentTab.id, { type }, { frameId: 0 });
        return retry || { ok: false, error: '页面没有响应，请刷新后重试。' };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: '页面脚本已失效，请刷新页面（F5）后重试。' };
  }
}

/* ---------------------------------------------------------------- */
/* 状态展示                                                          */
/* ---------------------------------------------------------------- */

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number < 1000) return String(number);
  if (number < 1000000) return `${(number / 1000).toFixed(1)}K`;
  return `${(number / 1000000).toFixed(2)}M`;
}

function renderStats(stats) {
  const supported = currentTab && isSupportedUrl(currentTab.url);
  const total = Number(stats?.total) || 0;
  const translated = Number(stats?.translated) || 0;
  const failed = Number(stats?.failed) || 0;
  const running = !!stats?.running;
  const error = stats?.error || '';
  const enabled = !!stats?.enabled;

  const dot = $('dot');
  dot.className = 'dot';

  if (!supported) {
    $('statusText').textContent = '当前页面不支持';
    $('percentText').textContent = '';
    $('barFill').style.width = '0%';
    $('metaText').textContent = '仅支持 http / https 网页（浏览器内部页面无法翻译）。';
    $('btnTranslate').disabled = true;
    $('btnRestore').disabled = true;
    $('autoSite').disabled = true;
    $('siteTypeText').textContent = '';
    return;
  }

  $('btnTranslate').disabled = busy;
  $('autoSite').disabled = busy;

  if (error) {
    dot.classList.add('error');
    $('statusText').textContent = '翻译出错';
    $('percentText').textContent = '';
    $('barFill').style.width = '100%';
    $('metaText').textContent = error.length > 120 ? `${error.slice(0, 120)}…` : error;
  } else if (running) {
    dot.classList.add('live');
    $('statusText').textContent = total ? '正在翻译…' : '正在扫描页面…';
    $('percentText').textContent = total ? `${Math.round((translated / total) * 100)}%` : '';
    $('barFill').style.width = `${total ? Math.round((translated / total) * 100) : 4}%`;
    $('metaText').textContent = total ? `已翻译 ${translated} 段，共发现 ${total} 段文本` : '正在提取页面文本';
  } else if (translated > 0) {
    dot.classList.add('done');
    $('statusText').textContent = '已翻译';
    $('percentText').textContent = total ? `${Math.round((translated / total) * 100)}%` : '100%';
    $('barFill').style.width = '100%';
    $('metaText').textContent = `已翻译 ${translated} 段${failed ? `，失败 ${failed} 段` : ''}，共发现 ${total} 段文本`;
  } else {
    $('statusText').textContent = '未翻译';
    $('percentText').textContent = '';
    $('barFill').style.width = '0%';
    $('metaText').textContent = '点击“翻译本页”开始整页越南语 → 中文翻译。';
  }

  $('btnRestore').disabled = busy || (!enabled && translated === 0 && !error);
  $('siteTypeText').textContent = stats?.siteLabel ? `站点类型：${stats.siteLabel}` : '';
}

async function refreshStats() {
  if (!currentTab) return;
  if (!isSupportedUrl(currentTab.url)) {
    renderStats(null);
    $('usageText').textContent = '';
    return;
  }

  let stats = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_GET_STATS', tabId: currentTab.id });
    if (response && response.ok && response.stats) stats = response.stats;
  } catch {
    /* 后台暂时不可用 */
  }

  if (!stats) {
    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, { type: 'VI2ZH_STATUS' }, { frameId: 0 });
      if (response && response.ok) {
        stats = {
          total: response.total || 0,
          translated: response.translated || 0,
          failed: response.failed || 0,
          running: !!response.running,
          error: response.error || '',
          enabled: !!response.enabled
        };
      }
    } catch {
      /* 没有内容脚本 */
    }
  }

  renderStats(stats);
}

async function refreshUsage() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_GET_USAGE' });
    const usage = response && response.usage;
    if (!usage) {
      $('usageText').textContent = '';
      return;
    }
    const cached = Number(response.cacheCount) || 0;
    if (!usage.requests) {
      $('costText').textContent = '≈ ¥0.0000';
      $('costNote').textContent = '尚未产生费用';
      $('usageText').textContent = cached
        ? `本地已缓存 ${cached} 条译文 · 重复内容不再计费`
        : '尚未产生 API 请求 · 译文缓存在本机，重复内容不再计费';
      return;
    }
    const today = Number(response.today?.costCNY) || 0;
    const total = Number(usage.costCNY) || 0;
    $('costText').textContent = `今日 ¥${formatMoney(today)} · 累计 ¥${formatMoney(total)}`;
    const period = response.period || (response.peakNow
      ? { label: '高峰价', reason: '工作日' }
      : { label: '空闲价', reason: '非高峰' });
    $('costNote').textContent = `${period.label} · ${period.until || period.reason}`;

    const hit = Number(usage.cacheHitTokens) || 0;
    const miss = Number.isFinite(usage.cacheMissTokens)
      ? usage.cacheMissTokens
      : Math.max(0, (usage.promptTokens || 0) - hit);
    const parts = [`${usage.requests} 次请求`];
    parts.push(`输入 ${formatTokens(hit + miss)}（缓存命中 ${formatTokens(hit)}）`);
    parts.push(`输出 ${formatTokens(usage.completionTokens || 0)}`);
    if (cached) parts.push(`本地缓存 ${cached} 条`);
    $('usageText').textContent = parts.join(' · ');
    $('usageText').title = '按 DeepSeek 官方价估算：空闲时段为高峰价的一半；法定节假日未单独计入';
  } catch {
    $('usageText').textContent = '';
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!currentTab) return;
    await refreshStats();
  }, 900);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
}

/* ---------------------------------------------------------------- */
/* 主操作                                                            */
/* ---------------------------------------------------------------- */

async function doTranslate() {
  if (busy) return;
  if (!currentTab || !isSupportedUrl(currentTab.url)) {
    showNotice($('notice'), '当前页面不支持翻译。', 'warn');
    return;
  }
  const next = collectForm();
  if (!settings.apiKey) {
    openSettings();
    showNotice($('settingsNotice'), next.apiKey
      ? '请先点击“保存设置”，把 API Key 保存到本机后再翻译。'
      : '请先填写 DeepSeek API Key 并保存。', 'warn');
    return;
  }

  busy = true;
  $('btnTranslate').disabled = true;
  $('btnRestore').disabled = true;
  hideNotice($('notice'));

  try {
    const injected = await ensureContentScript(currentTab.id);
    if (!injected) {
      showNotice($('notice'), '无法注入页面脚本：请刷新页面后重试。', 'warn');
      return;
    }
    const response = await sendToTab('VI2ZH_START');
    if (response && response.needKey) {
      openSettings();
      showNotice($('settingsNotice'), '请先填写 DeepSeek API Key 并保存。', 'warn');
    } else if (response && response.ok === false) {
      showNotice($('notice'), response.error || '启动翻译失败。', 'warn');
    }
  } finally {
    busy = false;
    await refreshStats();
    await refreshUsage();
  }
}

async function doRestore() {
  if (busy) return;
  if (!currentTab || !isSupportedUrl(currentTab.url)) return;
  busy = true;
  $('btnTranslate').disabled = true;
  $('btnRestore').disabled = true;
  hideNotice($('notice'));
  try {
    const injected = await ensureContentScript(currentTab.id);
    if (!injected) {
      showNotice($('notice'), '无法与页面通信：请刷新页面后重试。', 'warn');
      return;
    }
    await sendToTab('VI2ZH_RESTORE');
  } finally {
    busy = false;
    await refreshStats();
  }
}

/* ---------------------------------------------------------------- */
/* 本站自动翻译                                                      */
/* ---------------------------------------------------------------- */

async function refreshSiteSwitch() {
  const host = (() => {
    try {
      return new URL(currentTab?.url || '').hostname;
    } catch {
      return '';
    }
  })();
  const autoHosts = Array.isArray(settings.autoHosts) ? settings.autoHosts : [];
  $('autoSite').checked = !!host && autoHosts.includes(host);
  $('autoSite').disabled = !currentTab || !isSupportedUrl(currentTab.url);

  if (!host) {
    $('siteHint').textContent = '当前页面没有可识别的站点域名。';
  } else if (autoHosts.includes(host)) {
    $('siteHint').textContent = `打开 ${host} 的页面时自动翻译。`;
  } else {
    $('siteHint').textContent = `当前站点：${host}（开启后访问该站点自动翻译）`;
  }
}

async function onToggleAutoSite() {
  if (!currentTab) return;
  let host;
  try {
    host = new URL(currentTab.url).hostname;
  } catch {
    return;
  }
  if (!host) return;

  const set = new Set(Array.isArray(settings.autoHosts) ? settings.autoHosts : []);
  if ($('autoSite').checked) set.add(host);
  else set.delete(host);
  settings = { ...settings, autoHosts: [...set] };
  await storageSetSettings(settings);
  await refreshSiteSwitch();
}

/* ---------------------------------------------------------------- */
/* 设置                                                              */
/* ---------------------------------------------------------------- */

function openSettings() {
  const panel = $('settingsPanel');
  panel.open = true;
  panel.scrollIntoView({ block: 'nearest' });
}

async function saveSettings() {
  const next = collectForm();
  const error = validateForm(next);
  if (error) {
    showNotice($('settingsNotice'), error, 'warn');
    return false;
  }
  if (!(await ensureHostPermission(next.baseUrl))) {
    showNotice($('settingsNotice'), '未获得接口域名权限，无法保存该接口地址。请重新点击保存并允许授权。', 'warn');
    return false;
  }
  await storageSetSettings(next);
  settings = next;
  fillForm(next);
  showNotice($('settingsNotice'), '设置已保存。', 'ok');
  await refreshSiteSwitch();
  await refreshUsage();
  return true;
}

async function testConnection() {
  const form = collectForm();
  if (!form.apiKey) {
    showNotice($('settingsNotice'), '请先填写 API Key。', 'warn');
    return;
  }
  $('btnTest').disabled = true;
  showNotice($('settingsNotice'), '正在测试接口连接…', 'info');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_TEST', settings: form });
    if (response && response.ok) {
      const latency = response.latencyMs ? `（${response.latencyMs} ms）` : '';
      showNotice($('settingsNotice'), `连接成功${latency}，模型：${response.model || form.model}。`, 'ok');
    } else {
      showNotice($('settingsNotice'), `连接失败：${response?.error || response?.hint || '未知错误'}`, 'warn');
    }
  } catch (err) {
    showNotice($('settingsNotice'), `连接失败：${err.message || err}`, 'warn');
  } finally {
    $('btnTest').disabled = false;
  }
}

async function checkBalance() {
  const form = collectForm();
  if (!form.apiKey) {
    showNotice($('settingsNotice'), '请先填写并保存 API Key。', 'warn');
    return;
  }
  $('btnBalance').disabled = true;
  showNotice($('settingsNotice'), '正在查询账户余额…', 'info');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_BALANCE', settings: form });
    if (response && response.ok) {
      const currency = response.currency === 'USD' ? '$' : '¥';
      const parts = [`账户余额 ${currency}${formatMoney(response.total)}`];
      if (response.granted) parts.push(`赠送 ${currency}${formatMoney(response.granted)}`);
      if (response.toppedUp) parts.push(`充值 ${currency}${formatMoney(response.toppedUp)}`);
      showNotice($('settingsNotice'), parts.join(' · '), 'ok');
    } else {
      showNotice($('settingsNotice'), response?.error || '查询余额失败', 'warn');
    }
  } catch (err) {
    showNotice($('settingsNotice'), `查询余额失败：${err.message || err}`, 'warn');
  } finally {
    $('btnBalance').disabled = false;
  }
}

async function clearCache() {
  if (!window.confirm('确定清空本机译文缓存吗？之后遇到相同文本会重新调用 API。')) return;
  $('btnClearCache').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'VI2ZH_CLEAR_CACHE' });
    const cleared = response && typeof response.cleared === 'number' ? response.cleared : 0;
    showNotice($('settingsNotice'), `已清空 ${cleared} 条缓存。`, 'ok');
    await refreshUsage();
  } catch (err) {
    showNotice($('settingsNotice'), `清空失败：${err.message || err}`, 'warn');
  } finally {
    $('btnClearCache').disabled = false;
  }
}

/* ---------------------------------------------------------------- */
/* 初始化                                                            */
/* ---------------------------------------------------------------- */

function bindEvents() {
  $('btnTranslate').addEventListener('click', doTranslate);
  $('btnRestore').addEventListener('click', doRestore);
  $('autoSite').addEventListener('change', onToggleAutoSite);
  $('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('modeSelect').addEventListener('change', async () => {
    settings = { ...DEFAULTS, ...(settings || {}), mode: $('modeSelect').value === 'bilingual' ? 'bilingual' : 'replace' };
    await storageSetSettings(settings);
    await refreshStats();
  });
  $('btnSave').addEventListener('click', saveSettings);
  $('btnTest').addEventListener('click', testConnection);
$('btnBalance').addEventListener('click', checkBalance);
  $('btnClearCache').addEventListener('click', clearCache);

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    $('toggleKey').textContent = visible ? '显示' : '隐藏';
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else {
      refreshStats();
      startPolling();
    }
  });
}

async function init() {
  try {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    /* 忽略 */
  }
  bindEvents();
  settings = await storageGetSettings();
  fillForm(settings);

  currentTab = await getActiveTab();
  await refreshSiteSwitch();
  await refreshStats();
  await refreshUsage();
  startPolling();

  if (!currentTab) {
    showNotice($('notice'), '没有找到活动标签页。', 'warn');
  } else if (!isSupportedUrl(currentTab.url)) {
    showNotice($('notice'), '浏览器内部页面无法注入翻译脚本，请在普通网页中使用。', 'warn');
  } else if (!settings.apiKey) {
    showNotice($('notice'), '首次使用：展开“设置与术语表”，填入 DeepSeek API Key 并保存。', 'warn');
    openSettings();
  }
}

init();
