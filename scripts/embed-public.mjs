#!/usr/bin/env node
/** 把 public/ 静态资源内嵌为 src/assets.generated.js（供单文件二进制使用，二进制完全自包含）。 */
import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.resolve('public');
const outFile = path.resolve('src/assets.generated.js');

const assets = {};
for (const f of fs.readdirSync(publicDir)) {
  const full = path.join(publicDir, f);
  if (!fs.statSync(full).isFile()) continue;
  if (/\.(html|css|js|mjs|json|svg|png|ico|txt)$/i.test(f)) {
    assets[f] = fs.readFileSync(full, 'utf8');
  }
}

const content =
  '// 自动生成（scripts/embed-public.mjs），请勿手动编辑。\n' +
  '// public/ 静态资源内嵌，供单文件二进制直接服务页面。\n' +
  `export const embeddedAssets = ${JSON.stringify(assets, null, 2)};\n`;
fs.writeFileSync(outFile, content, 'utf8');
console.log(`已内嵌 ${Object.keys(assets).length} 个静态资源 -> ${outFile}`);
