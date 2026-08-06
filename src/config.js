import path from 'node:path';
import fs from 'node:fs';

/**
 * 服务配置加载。所有配置项均可通过环境变量覆盖。
 *
 * 环境变量：
 *   PORT            监听端口（默认 8888）
 *   HOST            监听地址（默认 0.0.0.0）
 *   DATA_DIR        数据目录（默认 <cwd>/data）
 *   RULES_FILE      规则存储文件（默认 <DATA_DIR>/rules.json）
 *   CADDY_BIN       caddy 可执行文件（默认 caddy）
 *   CADDYFILE_PATH  生成的 Caddyfile 目标路径（默认：/etc/caddy/Caddyfile 可写则用之，否则 <DATA_DIR>/Caddyfile）
 *   CADDY_RELOAD_CMD 自定义重载命令（例如 "systemctl reload caddy"），设置后优先于 caddy reload
 *   CADDY_START_CMD  自定义启动命令（例如 "systemctl restart caddy"），caddy 未运行时使用
 *   AUTH_TOKEN      访问 API 的 Bearer Token，为空表示不鉴权
 *   GLOBAL_TLS_EMAIL 全局 ACME 邮箱（写入 Caddyfile 全局块）
 *   SEED_EXAMPLES   首次启动时写入示例规则（1=是）
 *   DNS_WATCH_INTERVAL_MS 动态 DNS 看门狗扫描间隔（毫秒，默认 5000；manager 模式规则按各自 dnsInterval 节流）
 */
export function loadConfig(env = process.env) {
  const cwd = process.cwd();
  const dataDir = path.resolve(env.DATA_DIR || path.join(cwd, 'data'));

  let caddyfilePath = env.CADDYFILE_PATH
    ? path.resolve(env.CADDYFILE_PATH)
    : path.join(dataDir, 'Caddyfile');
  if (!env.CADDYFILE_PATH && process.platform !== 'win32') {
    // 生产环境默认写入 /etc/caddy/Caddyfile（可写时）
    try {
      fs.accessSync('/etc/caddy', fs.constants.W_OK);
      caddyfilePath = '/etc/caddy/Caddyfile';
    } catch {
      // 不可写则回退到数据目录
    }
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: parsePort(env.PORT) || 8888,
    dataDir,
    rulesFile: path.resolve(env.RULES_FILE || path.join(dataDir, 'rules.json')),
    caddyBin: env.CADDY_BIN || 'caddy',
    caddyfilePath,
    caddyReloadCmd: env.CADDY_RELOAD_CMD || '',
    caddyStartCmd: env.CADDY_START_CMD || '',
    authToken: env.AUTH_TOKEN || '',
    globalTlsEmail: env.GLOBAL_TLS_EMAIL || '',
    seedExamples: env.SEED_EXAMPLES === '1' || env.SEED_EXAMPLES === 'true',
    dnsWatchIntervalMs: Number.parseInt(env.DNS_WATCH_INTERVAL_MS, 10) || 5000,
    quiet: env.QUIET === '1' || env.QUIET === 'true',
  };
}

function parsePort(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
