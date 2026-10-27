#!/usr/bin/env node
/* 纯逻辑离线单测：语言识别、站点识别、峰谷价格、清单与打包约束 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function loadShared(file) {
  const sandbox = { console, TextEncoder, URL, Date, Intl };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared', file), 'utf8'), sandbox, { filename: file });
  return sandbox;
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
}

const langBox = loadShared('lang.js');
const L = langBox.VI2ZH_LANG;
const sitesBox = loadShared('sites.js');
const S = sitesBox.VI2ZH_SITES;
const pricingBox = loadShared('pricing.js');
const P = pricingBox.VI2ZH_PRICING;

check('语言识别：越南语', L.detect('Tổng quan nghiệp vụ thường dùng').code === 'vi');
check('语言识别：中文', L.detect('发票号码与凭证日期').code === 'zh');
check('语言识别：英语', L.detect('Hello world, this is a sample sentence.').code === 'en');
check('语言识别：泰语', L.detect('สวัสดีครับ ยินดีต้อนรับ').code === 'th');
check('语言识别：日语', L.detect('こんにちは、これはテストです。').code === 'ja');
check('同语言高置信跳过', L.detect('发票号码').code === 'zh');
check('站点识别：MISA 域名', S.detect({ host: 'actasp.misa.vn' }).id === 'accounting');
check('站点识别：Shopee 域名', S.detect({ host: 'shopee.vn' }).id === 'ecommerce');
check('站点识别：文本命中', S.detect({ title: 'Hóa đơn chứng từ hạch toán công nợ', sample: '' }).id === 'accounting');
check('站点识别：普通站点兜底', S.detect({ host: 'example.com', title: 'Hello' }).id === 'generic');

check('峰谷：工作日上午高峰', P.isPeak(new Date('2026-10-21T10:00:00+08:00')) === true);
check('峰谷：午间空闲', P.isPeak(new Date('2026-10-21T12:30:00+08:00')) === false);
check('峰谷：周末空闲', P.isPeak(new Date('2026-10-24T10:00:00+08:00')) === false);
check('峰谷：法定节假日空闲', P.isPeak(new Date('2026-10-01T10:00:00+08:00')) === false);
check('峰谷：节假日原因', P.describe(new Date('2026-10-01T10:00:00+08:00')).reason === '法定节假日');
check('费用估算：高峰命中价', Math.abs(P.estimate({ model: 'deepseek-flash', hit: 1e6, peak: true }) - 0.02) < 1e-9);
check('费用估算：空闲半价', Math.abs(P.estimate({ model: 'deepseek-flash', hit: 1e6, peak: false }) - 0.01) < 1e-9);
check('模型别名：deepseek-chat → flash', P.canonical('deepseek-chat') === 'deepseek-flash');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
check('manifest：MV3', manifest.manifest_version === 3);
check('manifest：版本号格式', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
check('manifest：options 页', manifest.options_ui && manifest.options_ui.page === 'src/options.html');
const scripts = manifest.content_scripts[0].js;
check('manifest：内容脚本顺序', scripts.join(',') === 'src/shared/defaults.js,src/shared/lang.js,src/shared/sites.js,src/content.js', scripts);
check('manifest：GitHub API 权限', (manifest.host_permissions || []).includes('https://api.github.com/*'));

for (const file of ['src/options.html', 'src/options.css', 'src/options.js', 'src/shared/lang.js']) {
  check(`文件存在：${file}`, fs.existsSync(path.join(ROOT, file)));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
