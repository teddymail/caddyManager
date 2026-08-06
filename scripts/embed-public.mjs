#!/usr/bin/env node
/** 把 public/ 静态资源内嵌为 src/assets.generated.js（供单文件二进制使用，二进制完全自包含）。
 *  index.html 中对 /app.js 和 /style.css 的引用会自动追加内容哈希版本号（?v=xxx），
 *  前端文件一变 URL 就变，彻底避免浏览器缓存旧脚本导致功能不一致。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const publicDir = path.resolve('public');
const outFile = path.resolve('src/assets.generated.js');

const assets = {};
let allContent = '';
for (const f of fs.readdirSync(publicDir)) {
  const full = path.join(publicDir, f);
  if (!fs.statSync(full).isFile()) continue;
  if (/\.(html|css|js|mjs|json|svg|png|ico|txt)$/i.test(f)) {
    const content = fs.readFileSync(full, 'utf8');
    assets[f] = content;
    allContent += content;
  }
}

// 内容哈希版本号：任何前端文件变化都会导致版本号变化
const ver = crypto.createHash('md5').update(allContent).digest('hex').slice(0, 8);
if (assets['index.html']) {
  assets['index.html'] = assets['index.html']
    .replace('src="/app.js"', `src="/app.js?v=${ver}"`)
    .replace('href="/style.css"', `href="/style.css?v=${ver}"`);
}

const content =
  '// 自动生成（scripts/embed-public.mjs），请勿手动编辑。\n' +
  '// public/ 静态资源内嵌，供单文件二进制直接服务页面。\n' +
  `export const embeddedAssets = ${JSON.stringify(assets, null, 2)};\n`;
fs.writeFileSync(outFile, content, 'utf8');
console.log(`已内嵌 ${Object.keys(assets).length} 个静态资源（前端版本号 v=${ver}） -> ${outFile}`);
