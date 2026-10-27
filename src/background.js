/* 越译中 · 后台 Service Worker
 * 职责：调用 DeepSeek、维护术语表与译文缓存、统计用量、聚合各 frame 的进度。
 */
'use strict';

importScripts('shared/defaults.js', 'shared/glossary.js', 'shared/pricing.js', 'shared/sites.js');

const SETTINGS_KEY = 'settings';
const CACHE_KEY = 'trCache';
const USAGE_KEY = 'usage';
const CACHE_LIMIT = 8000;
const MAX_TEXTS_PER_REQUEST = 60;

const SYSTEM_PROMPT = [
  '你是「越译中」网页翻译引擎，专门把越南语网页界面翻译成简体中文。',
  '用户会发送一个 JSON 对象：{"glossary": {"越南语术语": "中文译法"}, "texts": ["...", "..."]}。',
  '你必须只输出一个 JSON 对象：{"translations": ["...", "..."]}。',
  '',
  '硬性规则：',
  '1. translations 必须与 texts 等长、逐条一一对应；不得合并、拆分、遗漏、增加或调换顺序。',
  '2. 只输出 JSON 本身，不要 Markdown 代码块，不要解释，不要任何前后缀。',
  '3. 保留占位符与格式：{0}、{{name}}、%s、%d、<br>、换行、URL、邮箱、税号、金额数字、日期（dd/MM/yyyy）、时间、快捷键、单位符号。',
  '4. 品牌、产品名与缩写保留原文（如 MISA、Excel、Zalo、Viettel、VND、VNĐ）；越南专有名词用通用中文译名。',
  '5. 界面用语简洁自然（按钮 2~6 字），符合中文互联网产品习惯；术语严格优先采用 glossary 中的译法。',
  '6. 原文已是中文、纯数字、乱码或确实无法翻译时，原样返回该条。',
  '7. 不要添加原文没有的标点、语气词或说明；英文缩写保持大写。',
  '8. 即使单条文本很短，也必须给出译文，不允许返回空字符串。'
].join('\n');

function siteInstruction(siteType) {
  const sites = globalThis.VI2ZH_SITES;
  const profile = sites && sites.profileOf ? sites.profileOf(siteType) : null;
  if (!profile) return '';
  return `\n\n当前站点类型：${profile.label}。\n${profile.prompt.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

let settingsCache = null;
const settingsReady = chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
  settingsCache = { ...globalThis.VI2ZH_DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  return settingsCache;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  settingsCache = { ...globalThis.VI2ZH_DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
});

async function getSettings() {
  if (!settingsCache) {
    settingsCache = await settingsReady;
  }
  return settingsCache;
}

/* ------------------------------------------------------------------ */
/* 译文缓存（按 文本+模型+术语表 哈希）                                 */
/* ------------------------------------------------------------------ */

const translationCache = new Map();
let cacheLoadPromise = null;
let cacheFlushTimer = 0;
let cacheDirty = false;

function loadCache() {
  if (!cacheLoadPromise) {
    cacheLoadPromise = chrome.storage.local.get(CACHE_KEY).then((stored) => {
      const obj = stored[CACHE_KEY] || {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && value) translationCache.set(key, value);
      }
      return translationCache;
    });
  }
  return cacheLoadPromise;
}

function putCache(key, value) {
  translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
  cacheDirty = true;
  if (!cacheFlushTimer) cacheFlushTimer = setTimeout(flushCache, 4000);
}

async function flushCache() {
  cacheFlushTimer = 0;
  if (!cacheDirty) return;
  cacheDirty = false;
  const obj = {};
  for (const [key, value] of translationCache) obj[key] = value;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: obj });
  } catch (err) {
    console.warn('[越译中] 缓存写入失败', err);
  }
}

async function cacheKey(text, settings, siteType) {
  const raw = `${settings.model || ''}\u0000${settings.baseUrl || ''}\u0000${settings.glossaryText || ''}\u0000${siteType}\u0000${text}`;
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* 用量统计                                                            */
/* ------------------------------------------------------------------ */

let usageCache = null;

function blankUsage() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costCNY: 0,
    byModel: {},
    daily: {},
    since: Date.now()
  };
}

async function readUsage() {
  if (!usageCache) {
    const stored = await chrome.storage.local.get(USAGE_KEY);
    usageCache = { ...blankUsage(), ...(stored[USAGE_KEY] || {}) };
    if (!usageCache.byModel || typeof usageCache.byModel !== 'object') usageCache.byModel = {};
    if (!usageCache.daily || typeof usageCache.daily !== 'object') usageCache.daily = {};
  }
  return usageCache;
}

async function addUsage(usage, model, startedAt = Date.now()) {
  if (!usage) return;
  const current = await readUsage();
  const pricing = globalThis.VI2ZH_PRICING;
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = Number.isFinite(usage.prompt_cache_miss_tokens)
    ? usage.prompt_cache_miss_tokens
    : Math.max(0, (usage.prompt_tokens || 0) - hit);
  const out = usage.completion_tokens || 0;
  const peak = pricing.isPeak(new Date(startedAt));
  const cost = pricing.estimate({ model, hit, miss, out, peak });
  const key = pricing.canonical(model);

  current.requests += 1;
  current.promptTokens += usage.prompt_tokens || 0;
  current.completionTokens += out;
  current.cacheHitTokens += hit;
  current.cacheMissTokens += miss;
  current.costCNY = (current.costCNY || 0) + cost;

  const byModel = current.byModel[key] || { requests: 0, tokens: 0, costCNY: 0 };
  byModel.requests += 1;
  byModel.tokens += (usage.prompt_tokens || 0) + out;
  byModel.costCNY += cost;
  current.byModel[key] = byModel;

  const day = pricing.beijingDate(new Date(startedAt));
  const daily = current.daily[day] || { requests: 0, tokens: 0, costCNY: 0 };
  daily.requests += 1;
  daily.tokens += (usage.prompt_tokens || 0) + out;
  daily.costCNY += cost;
  current.daily[day] = daily;

  const days = Object.keys(current.daily).sort();
  while (days.length > 60) delete current.daily[days.shift()];

  current.updatedAt = Date.now();
  chrome.storage.local.set({ [USAGE_KEY]: current }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 术语表                                                              */
/* ------------------------------------------------------------------ */

function activeGlossary(settings) {
  const glossary = { ...(globalThis.VI2ZH_GLOSSARY || {}) };
  const lines = String(settings.glossaryText || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const vi = line.slice(0, index).trim();
    const zh = line.slice(index + 1).trim();
    if (vi && zh) glossary[vi] = zh;
  }
  return glossary;
}

/** 只把本批文本里真实出现的术语发给模型，避免每批都带整张表。 */
function pickGlossary(texts, settings) {
  const joined = texts.join('\n').toLowerCase();
  const picked = {};
  for (const [vi, zh] of Object.entries(activeGlossary(settings))) {
    if (joined.includes(vi.toLowerCase())) picked[vi] = zh;
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* DeepSeek 调用                                                       */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, { status = 0, fatal = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fatal = fatal;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_CONCURRENT_CALLS = 4;
let activeCalls = 0;
const waitingCalls = [];

async function acquireSlot() {
  if (activeCalls < MAX_CONCURRENT_CALLS) {
    activeCalls += 1;
    return;
  }
  await new Promise((resolve) => waitingCalls.push(resolve));
  activeCalls += 1;
}

function releaseSlot() {
  activeCalls -= 1;
  const next = waitingCalls.shift();
  if (next) next();
}

async function apiFetch(url, options, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('请求超时（90 秒），请检查网络或接口地址');
    throw new ApiError(`网络请求失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseTranslationPayload(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError('模型返回为空');
  }
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
      const list = Array.isArray(parsed) ? parsed : parsed.translations || parsed.texts || parsed.result;
      if (Array.isArray(list)) return list.map(normalizeItem);
    } catch {
      /* 继续尝试数组解析 */
    }
  }

  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed)) return parsed.map(normalizeItem);
    } catch {
      /* fall through */
    }
  }

  throw new ApiError('模型返回的内容不是有效 JSON，已自动拆批重试');
}

function normalizeItem(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.translation === 'string') return item.translation;
  if (item && typeof item.text === 'string') return item.text;
  return '';
}

async function callDeepSeek(texts, settings, siteType) {
  const baseUrl = String(settings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = settings.model || 'deepseek-flash';
  const payload = {
    model,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}${siteInstruction(siteType)}` },
      { role: 'user', content: JSON.stringify({ glossary: pickGlossary(texts, settings), texts }) }
    ],
    temperature: 1.0,
    max_tokens: 8192,
    stream: false
  };
  // deepseek-reasoner 不支持 response_format，靠提示词约束 JSON。
  if (!/reasoner/i.test(model)) {
    payload.response_format = { type: 'json_object' };
  }
  // 翻译不需要思维链：V4 系列默认开启思考模式，显式关闭，省时省钱。
  if (/^deepseek-(flash|v4-pro)/.test(model)) {
    payload.thinking = { type: 'disabled' };
  }

  const startedAt = Date.now();
  await acquireSlot();
  let response;
  try {
    response = await apiFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(payload)
    });
  } finally {
    releaseSlot();
  }

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* 保留 raw 以便截取错误信息 */
  }

  if (!response.ok) {
    const detail = data?.error?.message || raw.slice(0, 300) || response.statusText;
    const fatal = [400, 401, 402, 403, 404].includes(response.status) && !/rate|limit/i.test(detail);
    throw new ApiError(`DeepSeek 接口错误 ${response.status}：${detail}`, {
      status: response.status,
      fatal
    });
  }
  if (!data) throw new ApiError('接口返回的不是 JSON，请检查接口地址');
  if (data.error) throw new ApiError(`DeepSeek 返回错误：${data.error.message || JSON.stringify(data.error)}`);

  const content = data.choices?.[0]?.message?.content;
  const list = parseTranslationPayload(content);
  addUsage(data.usage, model, startedAt).catch(() => {});

  if (list.length !== texts.length) {
    throw new ApiError(`译文本条数不匹配（${list.length}/${texts.length}），已自动拆批重试`);
  }
  return list;
}

async function requestWithRetry(texts, settings, siteType) {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await callDeepSeek(texts, settings, siteType);
    } catch (err) {
      if (err instanceof ApiError && err.fatal) throw err;
      const retryable =
        !err.status ||
        [408, 409, 425, 429, 500, 502, 503, 504].includes(err.status) ||
        /超时|网络|条数|JSON|为空|拆批/.test(err.message);
      if (!retryable || attempt === attempts - 1) throw err;
      await sleep(800 * 2 ** attempt + Math.random() * 300);
    }
  }
  throw new ApiError('未知错误');
}

/**
 * 先整批翻译；若失败或条数不匹配就二分拆批，最多拆 3 层。
 * 拆批中某一半彻底失败时用空串占位，让另一半的译文仍能生效。
 */
async function translateWithSplit(texts, settings, depth = 0, siteType = 'generic') {
  try {
    return await requestWithRetry(texts, settings, siteType);
  } catch (err) {
    if (err instanceof ApiError && err.fatal) throw err;
    if (texts.length <= 1 || depth >= 3) throw err;

    const mid = Math.ceil(texts.length / 2);
    const leftTexts = texts.slice(0, mid);
    const rightTexts = texts.slice(mid);

    let left;
    try {
      left = await translateWithSplit(leftTexts, settings, depth + 1, siteType);
    } catch (leftError) {
      if (leftError instanceof ApiError && leftError.fatal) throw leftError;
      left = new Array(leftTexts.length).fill('');
    }
    let right;
    try {
      right = await translateWithSplit(rightTexts, settings, depth + 1, siteType);
    } catch (rightError) {
      if (rightError instanceof ApiError && rightError.fatal) throw rightError;
      right = new Array(rightTexts.length).fill('');
    }
    return left.concat(right);
  }
}

async function translateBatch(texts, settings, { skipCache = false, siteType = 'generic' } = {}) {
  await loadCache();
  const keys = await Promise.all(texts.map((text) => cacheKey(text, settings, siteType)));

  const translations = {};
  const misses = [];

  texts.forEach((text, index) => {
    const cached = skipCache ? '' : translationCache.get(keys[index]);
    if (cached) {
      translations[text] = cached;
    } else {
      misses.push({ text, key: keys[index] });
    }
  });

  let error = null;
  let fatal = false;
  if (misses.length) {
    try {
      const list = await translateWithSplit(misses.map((item) => item.text), settings, 0, siteType);
      misses.forEach((item, index) => {
        const translated = typeof list[index] === 'string' ? list[index].trim() : '';
        if (!translated) return;
        translations[item.text] = translated;
        if (!skipCache) putCache(item.key, translated);
      });
    } catch (err) {
      error = err.message || String(err);
      fatal = err instanceof ApiError && err.fatal;
    }
  }

  const failed = texts.filter((text) => !translations[text]);
  return { translations, failed, error, fatal };
}

/* ------------------------------------------------------------------ */
/* 各标签页 / 各 frame 的进度聚合                                       */
/* ------------------------------------------------------------------ */

const tabFrames = new Map(); // tabId -> Map(frameId -> stats)
const persistTimers = new Map();

function updateStats(tabId, frameId, stats) {
  let frames = tabFrames.get(tabId);
  if (!frames) {
    frames = new Map();
    tabFrames.set(tabId, frames);
  }
  frames.set(frameId, { ...stats, at: Date.now() });
  refreshBadge(tabId);
  schedulePersist(tabId);
}

function aggregateStats(tabId) {
  const frames = tabFrames.get(tabId);
  if (!frames || frames.size === 0) return null;
  const total = { total: 0, translated: 0, failed: 0, running: false, enabled: false, error: '', siteType: '', siteLabel: '' };
  for (const stats of frames.values()) {
    total.total += stats.total || 0;
    total.translated += stats.translated || 0;
    total.failed += stats.failed || 0;
    total.running = total.running || !!stats.running;
    total.enabled = total.enabled || !!stats.enabled;
    if (stats.error) total.error = stats.error;
    if (!total.siteType && stats.siteType) {
      total.siteType = stats.siteType;
      total.siteLabel = stats.siteLabel || '';
    }
  }
  return total;
}

function refreshBadge(tabId) {
  const stats = aggregateStats(tabId);
  let text = '';
  if (stats && stats.total > 0) {
    if (stats.running) text = `${Math.min(99, Math.round((stats.translated / stats.total) * 100))}%`;
    else if (stats.failed > 0) text = '!';
    else text = '中';
  }
  chrome.action.setBadgeText({ tabId, text }, () => void chrome.runtime.lastError);
  chrome.action.setBadgeBackgroundColor(
    { tabId, color: stats && stats.failed ? '#b45309' : '#0d9488' },
    () => void chrome.runtime.lastError
  );
}

function schedulePersist(tabId) {
  if (persistTimers.has(tabId)) return;
  persistTimers.set(
    tabId,
    setTimeout(async () => {
      persistTimers.delete(tabId);
      const stats = aggregateStats(tabId);
      if (!stats) return;
      try {
        await chrome.storage.local.set({ [`stats:${tabId}`]: { ...stats, at: Date.now() } });
      } catch {
        /* 忽略 */
      }
    }, 800)
  );
}

async function getTabStats(tabId) {
  const memory = aggregateStats(tabId);
  if (memory) return memory;
  try {
    const key = `stats:${tabId}`;
    const stored = await chrome.storage.local.get(key);
    const stats = stored[key];
    if (!stats) return null;
    // 超过 30 分钟的历史进度视为过期
    if (Date.now() - (stats.at || 0) > 30 * 60 * 1000) return null;
    return stats;
  } catch {
    return null;
  }
}

function resetTab(tabId) {
  tabFrames.delete(tabId);
  const timer = persistTimers.get(tabId);
  if (timer) clearTimeout(timer);
  persistTimers.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }, () => void chrome.runtime.lastError);
  chrome.storage.local.remove(`stats:${tabId}`).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => resetTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') resetTab(tabId);
});

/* ------------------------------------------------------------------ */
/* 消息处理                                                            */
/* ------------------------------------------------------------------ */

async function handleTranslate(message, sender, sendResponse) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    sendResponse({ ok: false, fatal: true, error: '尚未配置 DeepSeek API Key', translations: {}, failed: message.texts || [] });
    return;
  }
  let texts = Array.isArray(message.texts) ? message.texts.filter((t) => typeof t === 'string' && t.trim()) : [];
  texts = [...new Set(texts)].slice(0, MAX_TEXTS_PER_REQUEST);
  if (!texts.length) {
    sendResponse({ ok: true, translations: {}, failed: [] });
    return;
  }
  const siteType = globalThis.VI2ZH_SITES ? globalThis.VI2ZH_SITES.resolve(message.siteType) : 'generic';
  try {
    const result = await translateBatch(texts, settings, { siteType });
    sendResponse({
      ok: true,
      siteType,
      translations: result.translations,
      failed: result.failed,
      error: result.error || null,
      fatal: !!result.fatal
    });
  } catch (err) {
    sendResponse({ ok: false, error: err.message || String(err), translations: {}, failed: texts });
  }
}

async function handleTest(message, sendResponse) {
  const settings = { ...(await getSettings()), ...(message.settings || {}) };
  if (!settings.apiKey) {
    sendResponse({ ok: false, error: '请先填写 API Key' });
    return;
  }
  const sample = 'Xin chào, đây là bản dịch thử nghiệm.';
  const startedAt = Date.now();
  try {
    const result = await translateBatch([sample], settings, { skipCache: true, siteType: 'generic' });
    if (result.translations[sample]) {
      sendResponse({
        ok: true,
        sample,
        translation: result.translations[sample],
        model: settings.model,
        latencyMs: Date.now() - startedAt
      });
    } else {
      sendResponse({ ok: false, error: result.error || '接口未返回译文' });
    }
  } catch (err) {
    sendResponse({ ok: false, error: err.message || String(err) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  switch (message.type) {
    case 'VI2ZH_TRANSLATE':
      handleTranslate(message, sender, sendResponse);
      return true;

    case 'VI2ZH_TEST':
      handleTest(message, sendResponse);
      return true;

    case 'VI2ZH_STATS': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined && sender.frameId !== undefined) {
        updateStats(tabId, sender.frameId, message.stats || {});
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'VI2ZH_FRAME_READY': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ start: false });
        return false;
      }
      getTabStats(tabId).then((stats) => {
        sendResponse({ start: !!(stats && (stats.enabled || stats.running || stats.total > 0)) });
      });
      return true;
    }

    case 'VI2ZH_GET_STATS': {
      const tabId = message.tabId ?? sender.tab?.id;
      getTabStats(tabId).then((stats) => sendResponse({ ok: true, stats }));
      return true;
    }

    case 'VI2ZH_GET_USAGE':
      Promise.all([readUsage(), loadCache()]).then(([usage]) => {
        usageCache = { ...usageCache, ...(usage || {}) };
        const pricing = globalThis.VI2ZH_PRICING;
        const todayKey = pricing.beijingDate();
        sendResponse({
          ok: true,
          usage,
          cacheCount: translationCache.size,
          today: usage.daily?.[todayKey] || { requests: 0, tokens: 0, costCNY: 0 },
          peakNow: pricing.isPeak(new Date()),
          period: pricing.describe(new Date())
        });
      });
      return true;

    case 'VI2ZH_BALANCE':
      (async () => {
        try {
          const settings = message.settings || (await getSettings());
          if (!settings.apiKey) throw new ApiError('请先填写并保存 API Key');
          const baseUrl = String(settings.baseUrl || 'https://api.deepseek.com');
          const url = new URL('/user/balance', baseUrl).toString();
          const response = await apiFetch(
            url,
            { headers: { Authorization: `Bearer ${settings.apiKey}` } },
            15000
          );
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            throw new ApiError(`查询余额失败（${response.status}）${data?.error?.message ? '：' + data.error.message : ''}`);
          }
          const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
          const info = infos.find((item) => item.currency === 'CNY') || infos[0];
          if (!info) throw new ApiError('接口未返回余额信息');
          sendResponse({
            ok: true,
            currency: info.currency || 'CNY',
            total: Number(info.total_balance) || 0,
            granted: Number(info.granted_balance) || 0,
            toppedUp: Number(info.topped_up_balance) || 0,
            available: data.is_available !== false
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
      })();
      return true;

    case 'VI2ZH_CLEAR_CACHE':
      loadCache().then(async () => {
        const cleared = translationCache.size;
        translationCache.clear();
        cacheDirty = false;
        await chrome.storage.local.remove(CACHE_KEY);
        sendResponse({ ok: true, cleared });
      });
      return true;

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/* 快捷键 / 右键菜单                                                   */
/* ------------------------------------------------------------------ */

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 安装扩展前就打开的页面没有内容脚本，按需注入
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/shared/defaults.js', 'src/content.js']
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function toggleTab(tab) {
  if (!tab || tab.id === undefined || !/^https?:/i.test(tab.url || '')) return;
  try {
    await sendToTab(tab.id, { type: 'VI2ZH_TOGGLE' });
  } catch (err) {
    console.warn('[越译中] 无法在当前页面运行：', err.message);
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await toggleTab(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create(
    { id: 'vi2zh-toggle', title: '越译中：翻译 / 还原此页面', contexts: ['page'] },
    () => void chrome.runtime.lastError
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'vi2zh-toggle') toggleTab(tab);
});
