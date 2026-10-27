/* 跨浏览器适配：Chrome 的 chrome.* 已是 Promise 风格，browser 不存在。
 * Firefox 的 chrome.* 是回调风格，browser.* 才是 Promise；这里统一交给 browser。
 * 业务代码只写 chrome.*，两种浏览器共用一套实现。
 */
'use strict';

(function (g) {
  if (!g.browser || g.browser === g.chrome) return;
  try {
    if (!g.browser.runtime || !g.browser.storage) return;
  } catch {
    return;
  }
  try {
    g.chrome = g.browser;
  } catch {
    try {
      Object.defineProperty(g, 'chrome', { value: g.browser, writable: true, configurable: true });
    } catch {
      /* 极少数环境不允许覆盖，只能继续用回调版 chrome */
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
