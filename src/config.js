import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

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
/** 读取运行时设置（面板手动指定的配置），损坏时忽略。 */
export function loadSettings(dataDir) {
  try {
    const f = path.join(dataDir, 'settings.json');
    if (fs.existsSync(f)) {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch { /* 忽略损坏文件 */ }
  return {};
}

/** 持久化运行时设置（原子写盘）。 */
export function saveSettings(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'settings.json');
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function writableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

/** 自动定位 Caddyfile 候选（按优先级）。 */
export function detectCaddyfileCandidates(dataDir) {
  const out = [];
  if (process.platform !== 'win32') {
    if (fs.existsSync('/etc/caddy/Caddyfile') || (fs.existsSync('/etc/caddy') && writableDir('/etc/caddy'))) {
      out.push({ path: '/etc/caddy/Caddyfile', source: 'auto' });
    }
  }
  try {
    const user = path.join(os.homedir(), '.config', 'caddy', 'Caddyfile');
    if (fs.existsSync(user)) out.push({ path: user, source: 'auto' });
  } catch { /* 跳过 */ }
  out.push({ path: path.join(dataDir, 'Caddyfile'), source: 'default' });
  return out;
}

export function loadConfig(env = process.env) {
  const cwd = process.cwd();
  const dataDir = path.resolve(env.DATA_DIR || path.join(cwd, 'data'));
  const settings = loadSettings(dataDir);
  const candidates = detectCaddyfileCandidates(dataDir);

  // Caddy 日志路径（自动定位）：/var/log/caddy 可写则用系统路径，否则回退数据目录
  const logDir = (() => {
    try { fs.accessSync('/var/log/caddy', fs.constants.W_OK); return '/var/log/caddy'; } catch { return dataDir; }
  })();
  const caddyAccessLog = env.CADDY_ACCESS_LOG
    ? path.resolve(env.CADDY_ACCESS_LOG)
    : settings.caddyAccessLog
      ? path.resolve(settings.caddyAccessLog)
      : path.join(logDir, 'access.log');
  const caddyErrorLog = env.CADDY_ERROR_LOG
    ? path.resolve(env.CADDY_ERROR_LOG)
    : settings.caddyErrorLog
      ? path.resolve(settings.caddyErrorLog)
      : path.join(logDir, 'error.log');
  const accessLogSource = env.CADDY_ACCESS_LOG ? 'env' : settings.caddyAccessLog ? 'manual' : 'auto';
  const errorLogSource = env.CADDY_ERROR_LOG ? 'env' : settings.caddyErrorLog ? 'manual' : 'auto';

  // 默认兜底（未匹配路由 -> 转发到 Caddy Manager 自身，返回 503 错误页）
  const fallbackEnabled = env.FALLBACK_ENABLED !== undefined
    ? env.FALLBACK_ENABLED !== '0' && env.FALLBACK_ENABLED !== 'false'
    : settings.fallbackEnabled !== undefined ? settings.fallbackEnabled : true;
  const fallbackStatus = Number(env.FALLBACK_STATUS || settings.fallbackStatus || 503);
  const fallbackTarget = env.FALLBACK_TARGET || `http://127.0.0.1:${Number.parseInt(env.PORT, 10) || 8888}`;

  // 鉴权（默认强制开启）：AUTH_TOKEN > 已持久化 token > 自动生成并持久化
  let authToken;
  let authTokenSource;
  if (env.AUTH_TOKEN) {
    authToken = env.AUTH_TOKEN.trim();
    authTokenSource = 'env';
  } else if (settings.authToken) {
    authToken = settings.authToken;
    authTokenSource = 'settings';
  } else {
    authToken = crypto.randomBytes(16).toString('hex');
    authTokenSource = 'generated';
    try {
      saveSettings(dataDir, { ...settings, authToken });
      settings.authToken = authToken; // 同步到内存，避免后续保存设置时覆盖丢失
    } catch { /* 持久化失败则仅本次运行有效 */ }
  }

  // 优先级：环境变量 > 面板手动设置 > 自动定位
  let caddyfilePath;
  let caddyfilePathSource;
  if (env.CADDYFILE_PATH) {
    caddyfilePath = path.resolve(env.CADDYFILE_PATH);
    caddyfilePathSource = 'env';
  } else if (settings.caddyfilePath) {
    caddyfilePath = path.resolve(settings.caddyfilePath);
    caddyfilePathSource = 'manual';
  } else {
    caddyfilePath = candidates[0].path;
    caddyfilePathSource = candidates[0].source;
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
    authToken,
    authTokenSource,
    globalTlsEmail: env.GLOBAL_TLS_EMAIL || '',
    seedExamples: env.SEED_EXAMPLES === '1' || env.SEED_EXAMPLES === 'true',
    dnsWatchIntervalMs: Number.parseInt(env.DNS_WATCH_INTERVAL_MS, 10) || 5000,
    quiet: env.QUIET === '1' || env.QUIET === 'true',
    logsEnabled: env.CADDY_LOGS !== '0' && env.CADDY_LOGS !== 'false',
    caddyAccessLog,
    caddyErrorLog,
    accessLogSource,
    errorLogSource,
    caddyLogDir: logDir,
    fallbackEnabled,
    fallbackStatus,
    fallbackTarget,
    settings,
    caddyfilePathSource,
    caddyfilePathCandidates: candidates,
  };
}

function parsePort(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
