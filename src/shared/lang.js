/* 越译中 · 语言识别与语言名称
 * 不依赖任何模型：按字符脚本 + 越南语特征词给页面/选中文本判定源语言。
 * 目标语言目前支持简体中文（zh）与越南语（vi），便于输入框反向翻译。
 */
'use strict';

(function (g) {
  const LANGS = {
    vi: { label: '越南语', targetLabel: '越南语' },
    zh: { label: '简体中文', targetLabel: '简体中文' },
    en: { label: '英语', targetLabel: '英语' },
    th: { label: '泰语', targetLabel: '泰语' },
    id: { label: '印尼语', targetLabel: '印尼语' },
    km: { label: '高棉语', targetLabel: '高棉语' },
    lo: { label: '老挝语', targetLabel: '老挝语' },
    ja: { label: '日语', targetLabel: '日语' },
    ko: { label: '韩语', targetLabel: '韩语' }
  };

  const SCRIPTS = [
    { code: 'th', re: /[\u0e00-\u0e7f]/g },
    { code: 'lo', re: /[\u0e80-\u0eff]/g },
    { code: 'km', re: /[\u1780-\u17ff]/g },
    { code: 'my', re: /[\u1000-\u109f]/g },
    { code: 'ja', re: /[\u3040-\u30ff]/g },
    { code: 'ko', re: /[\uac00-\ud7af]/g },
    { code: 'zh', re: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g }
  ];

  const VI_CHARS = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/g;
  const VI_WORDS = /(^|[\s,.;:!?()"“”])(và|hoặc|của|cho|không|được|ngày|tiền|hóa đơn|chứng từ|khách hàng|nhà cung cấp|tổng|báo cáo)(?=$|[\s,.;:!?()"“”])/gi;

  function countMatches(text, re) {
    const m = String(text).match(re);
    return m ? m.length : 0;
  }

  /** 返回 { code, label, confidence, scores } */
  function detect(input) {
    const text = String(input || '').slice(0, 20000);
    if (!text.trim()) return { code: 'unknown', label: '未知', confidence: 'low', scores: {} };

    const scores = {};
    for (const item of SCRIPTS) {
      const hits = countMatches(text, item.re);
      if (hits) scores[item.code] = (scores[item.code] || 0) + hits;
    }

    const viChars = countMatches(text, VI_CHARS);
    const viWords = countMatches(text, VI_WORDS);
    if (viChars) scores.vi = (scores.vi || 0) + viChars * 2;
    if (viWords) scores.vi = (scores.vi || 0) + viWords * 3;

    const latin = countMatches(text, /[A-Za-zÀ-ỹ]/g);
    const total = latin + Object.values(scores).reduce((a, b) => a + b, 0) || 1;
    if (!scores.vi && latin > 0) {
      // 纯拉丁文本：有空格且含 the/and/of 等高频词判为英语，否则按印尼语兜底
      if (/\b(the|and|of|to|in|is|for|with|from)\b/i.test(text)) scores.en = latin;
      else scores.id = latin;
    }

    let best = 'unknown';
    let bestScore = 0;
    for (const [code, score] of Object.entries(scores)) {
      if (score > bestScore) {
        best = code;
        bestScore = score;
      }
    }
    if (best === 'unknown') return { code: 'unknown', label: '未知', confidence: 'low', scores };
    const confidence = bestScore / total >= 0.25 ? 'high' : 'low';
    return { code: best, label: (LANGS[best] && LANGS[best].label) || best, confidence, scores };
  }

  function normalize(code) {
    const value = String(code || '').toLowerCase();
    if (LANGS[value]) return value;
    if (value.startsWith('zh')) return 'zh';
    return 'auto';
  }

  function label(code) {
    return (LANGS[normalize(code)] && LANGS[normalize(code)].label) || '未知';
  }

  /** 页面里没有可识别文字时返回 auto，交给提示词按原文处理 */
  function detectForTranslation(text, fallback = 'vi') {
    const result = detect(text);
    if (result.code === 'unknown') return { code: fallback, label: label(fallback), confidence: 'low', scores: {} };
    return result;
  }

  g.VI2ZH_LANG = { LANGS, detect, detectForTranslation, normalize, label };
})(globalThis);
