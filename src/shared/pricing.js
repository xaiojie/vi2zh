/* 越译中 · DeepSeek 官方价格表与费用估算
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 单位：元 / 百万 tokens。空闲时段 = 高峰价 × 0.5。
 * 高峰时段：北京时间周一至周五 09:00–12:00、14:00–18:00；
 * 周末与中国法定节假日全天按空闲时段。节假日表来自国务院办公厅通知，需每年更新一次。
 */
'use strict';

(function () {
  const MODELS = {
    'deepseek-flash': { label: 'DeepSeek Flash', hit: 0.02, miss: 1, out: 4 },
    'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', hit: 0.15, miss: 4.5, out: 13.5 }
  };

  const ALIASES = {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-v4-pro'
  };

  const OFF_PEAK_FACTOR = 0.5;

  // 国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）
  const HOLIDAYS_2026 = [
    '2026-01-01','2026-01-02','2026-01-03',
    '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
    '2026-04-04','2026-04-05','2026-04-06',
    '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
    '2026-06-19','2026-06-20','2026-06-21',
    '2026-09-25','2026-09-26','2026-09-27',
    '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'
  ];
  const HOLIDAYS = new Set(HOLIDAYS_2026);
  const HOLIDAYS_YEAR = 2026;

  function canonical(model) {
    const name = String(model || '').trim();
    if (MODELS[name]) return name;
    if (ALIASES[name]) return ALIASES[name];
    if (/pro|reasoner/i.test(name)) return 'deepseek-v4-pro';
    return 'deepseek-flash';
  }

  function priceFor(model) {
    return MODELS[canonical(model)] || MODELS['deepseek-flash'];
  }

  // 北京时间（UTC+8）下的星期与小时；不依赖运行环境的时区设置
  function beijingParts(date) {
    const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
    return {
      weekday: shifted.getUTCDay(), // 0=周日
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      date: shifted.toISOString().slice(0, 10)
    };
  }

  function isHoliday(date) {
    return HOLIDAYS.has(beijingParts(date).date);
  }

  /** 当前处于高峰还是空闲，以及切换时间，供界面展示 */
  function describe(date = new Date()) {
    const { weekday, hour, minute, date: day } = beijingParts(date);
    if (HOLIDAYS.has(day)) return { peak: false, label: '空闲价', reason: '法定节假日', until: null };
    if (weekday === 0 || weekday === 6) return { peak: false, label: '空闲价', reason: '周末', until: null };
    const mins = hour * 60 + minute;
    if (mins >= 540 && mins < 720) return { peak: true, label: '高峰价', reason: '工作日上午', until: '12:00 转空闲' };
    if (mins >= 840 && mins < 1080) return { peak: true, label: '高峰价', reason: '工作日下午', until: '18:00 转空闲' };
    if (mins >= 720 && mins < 840) return { peak: false, label: '空闲价', reason: '午间', until: '14:00 转高峰' };
    if (mins < 540) return { peak: false, label: '空闲价', reason: '早间', until: '09:00 转高峰' };
    return { peak: false, label: '空闲价', reason: '夜间', until: '次日 09:00 转高峰' };
  }

  function isPeak(date) {
    return describe(date).peak;
  }

  function estimate({ model, hit = 0, miss = 0, out = 0, peak = false }) {
    const price = priceFor(model);
    const factor = peak ? 1 : OFF_PEAK_FACTOR;
    const cost = (hit * price.hit + miss * price.miss + out * price.out) / 1e6;
    return cost * factor;
  }

  function beijingDate(date = new Date()) {
    return beijingParts(date).date;
  }

  globalThis.VI2ZH_PRICING = {
    MODELS,
    canonical,
    priceFor,
    isPeak,
    isHoliday,
    describe,
    HOLIDAYS_YEAR,
    beijingDate,
    estimate,
    OFF_PEAK_FACTOR
  };
})();
