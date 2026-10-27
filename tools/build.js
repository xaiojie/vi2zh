#!/usr/bin/env node
/**
 * 打包：递增 patch 版本 → 同步 dist → 生成 zip。
 *   node tools/build.js                 # Chrome/Edge：版本 +1 并打包
 *   node tools/build.js --no-bump       # 只重新打包
 *   node tools/build.js --firefox       # 生成 Firefox MV3 包（不覆盖 Chrome 包）
 * 产物：dist/vi2zh-translator（Chrome/Edge 加载这个目录）
 *      dist/vi2zh-firefox（Firefox about:debugging 临时加载）
 *      ../vi2zh-translator-v<version>.zip / ../vi2zh-firefox-v<version>.zip
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(ROOT, 'manifest.json');
const bump = !process.argv.includes('--no-bump');
const firefox = process.argv.includes('--firefox');
const NAME = firefox ? 'vi2zh-firefox' : 'vi2zh-translator';
const OUT = path.join(DIST, NAME);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const current = manifest.version;
if (bump) {
  const parts = current.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  manifest.version = parts.join('.');
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

// package.json 的版本号跟随 manifest
const packageFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
pkg.version = manifest.version;
fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of ['src', 'icons']) {
  fs.cpSync(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
}

let outManifest = manifest;
if (firefox) {
  outManifest = JSON.parse(JSON.stringify(manifest));
  delete outManifest.minimum_chrome_version;
  // Firefox 不支持 MV3 的 service_worker，改用事件页按顺序加载同一批脚本
  outManifest.background = {
    scripts: [
      'src/shared/platform.js',
      'src/shared/defaults.js',
      'src/shared/glossary.js',
      'src/shared/pricing.js',
      'src/shared/sites.js',
      'src/shared/lang.js',
      'src/background.js'
    ]
  };
  outManifest.browser_specific_settings = {
    gecko: {
      id: 'vi2zh@jay.local',
      strict_min_version: '128.0'
    }
  };
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(outManifest, null, 2) + '\n');

// 只保留当前版本的 zip，避免目录里堆一堆旧包
const parent = path.dirname(ROOT);
const prefix = firefox ? 'vi2zh-firefox-v' : 'vi2zh-translator-v';
for (const name of fs.readdirSync(parent)) {
  const match = new RegExp(`^${prefix}(\\d+\\.\\d+\\.\\d+)\\.zip$`).exec(name);
  if (match && match[1] !== manifest.version) fs.rmSync(path.join(parent, name), { force: true });
}

const zip = path.join(parent, `${NAME}-v${manifest.version}.zip`);
if (fs.existsSync(zip)) fs.rmSync(zip);
execFileSync('zip', ['-qr', zip, NAME], { cwd: DIST });

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(path.relative(OUT, full));
  }
})(OUT);

console.log(`target  ${firefox ? 'firefox' : 'chrome/edge'}`);
console.log(`version ${current}${bump ? ' -> ' + manifest.version : ''}`);
console.log(`dist    ${OUT}  (${files.length} files)`);
console.log(`zip     ${zip}`);
console.log(firefox
  ? '下一步：Firefox 打开 about:debugging → 临时载入附加组件 → 选择 dist/vi2zh-firefox/manifest.json'
  : '下一步：chrome://extensions → 该扩展「重新加载」；已打开的页面需刷新一次。');
