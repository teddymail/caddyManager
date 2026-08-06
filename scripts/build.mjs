#!/usr/bin/env node
/**
 * 用 Bun 把服务编译成单文件自包含可执行二进制（内置 JS 引擎，目标机无需安装 Node）。
 *
 * 用法:
 *   node scripts/build.mjs [target]
 *     target 默认 bun-darwin-x64（本机）；Linux 云主机用：
 *       node scripts/build.mjs bun-linux-x64      # 常见 x86_64 云主机
 *       node scripts/build.mjs bun-linux-arm64    # ARM64 云主机
 *
 * 产物输出到 dist/caddymanager-<platform>-<arch>
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const target = process.argv[2] || 'bun-darwin-x64';
const dist = path.resolve('dist');
fs.mkdirSync(dist, { recursive: true });

const name = `caddymanager-${target.replace(/^bun-/, '')}`;
const outfile = path.join(dist, name);

console.log(`[1/2] 重新生成内嵌静态资源...`);
execSync('node scripts/embed-public.mjs', { stdio: 'inherit' });

console.log(`[2/2] bun build --compile --target=${target} ...`);
execSync(`bun build --compile --target=${target} src/server.js --outfile ${outfile}`, { stdio: 'inherit' });

const sizeMB = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ 构建完成: ${outfile} (${sizeMB} MB, 单文件自包含)`);
console.log(`   目标机直接运行: ./${name}  （无需安装 Node）`);
