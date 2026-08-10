#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const handler = createApp(config);

const server = http.createServer(handler);

server.listen(config.port, config.host, () => {
  console.log(`==============================================`);
  console.log(`  Caddy Manager 已启动`);
  console.log(`  面板/API: http://${config.host}:${config.port}`);
  console.log(`  规则文件: ${config.rulesFile}`);
  console.log(`  Caddyfile: ${config.caddyfilePath}`);
  console.log(`  Caddy 可执行: ${config.caddyBin}`);
  console.log(`  动态 DNS 看门狗: ${config.dnsWatchIntervalMs ? `每 ${config.dnsWatchIntervalMs}ms 扫描` : '关闭'}`);
  // 权限/依赖自检
  try {
    fs.accessSync(path.dirname(config.caddyfilePath), fs.constants.W_OK);
  } catch {
    console.log(`  ⚠ 警告: Caddyfile 目标路径不可写: ${config.caddyfilePath}`);
    console.log(`    应用配置将无法写盘，请用 root 运行或设置 CADDYFILE_PATH 到可写目录`);
  }
  const authSource = config.authTokenSource === 'generated' ? '自动生成' : config.authTokenSource === 'env' ? '来自 AUTH_TOKEN' : '持久化';
  console.log(`  鉴权: 已启用 (Bearer Token · ${authSource})`);
  if (config.authTokenSource === 'generated') {
    console.log(`  ⚠ 访问令牌: ${config.authToken}`);
    console.log(`    （面板首次打开需输入此令牌，请妥善保存）`);
  }
  console.log(`==============================================`);
  handler.startDnsWatcher();
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在退出...`);
  handler.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
