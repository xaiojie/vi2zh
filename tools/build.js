#!/usr/bin/env node
/**
 * 打包：递增 patch 版本 → 同步 dist/vi2zh-translator → 生成 zip。
 *   node tools/build.js            # 版本 +1 并打包（日常改动用这个）
 *   node tools/build.js --no-bump  # 只重新打包，不改版本
 * 产物：dist/vi2zh-translator/（Chrome 加载这个目录）
 *      ../vi2zh-translator-v<version>.zip
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'vi2zh-translator');
const MANIFEST = path.join(ROOT, 'manifest.json');
const bump = !process.argv.includes('--no-bump');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const current = manifest.version;
if (bump) {
  const parts = current.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  manifest.version = parts.join('.');
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of ['manifest.json', 'src', 'icons']) {
  fs.cpSync(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
}

const zip = path.join(path.dirname(ROOT), `vi2zh-translator-v${manifest.version}.zip`);
if (fs.existsSync(zip)) fs.rmSync(zip);
execFileSync('zip', ['-qr', zip, 'vi2zh-translator'], { cwd: DIST });

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(path.relative(OUT, full));
  }
})(OUT);

console.log(`version ${current}${bump ? ' -> ' + manifest.version : ''}`);
console.log(`dist    ${OUT}  (${files.length} files)`);
console.log(`zip     ${zip}`);
console.log('下一步：chrome://extensions → 该扩展「重新加载」；已打开的页面需刷新一次。');
