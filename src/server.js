#!/usr/bin/env node
import http from 'node:http';
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
  console.log(`  鉴权: ${config.authToken ? '已启用 (Bearer Token)' : '未启用（建议设置 AUTH_TOKEN）'}`);
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
