import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { Router, sendJson, sendText, sendError, readBody, staticHandler } from './router.js';
import { Store } from './store.js';
import { generateCaddyfile } from './generator.js';
import { applyConfig, caddyInstalled, caddyRunning, detectRunningCaddyConfig } from './caddy.js';
import { exampleRules, defaultRule, deriveUpstreamHostPort } from './util.js';
import { saveSettings, detectCaddyfileCandidates } from './config.js';
import { readLogTail, parseCaddyLogLine } from './logs.js';
import { embeddedAssets } from './assets.generated.js';

export function createApp(config, { store } = {}) {
  const app = { config, store: store || new Store(config.rulesFile, { seedExamples: config.seedExamples }) };
  const router = new Router();

  // 生成结果缓存：规则未变化时直接复用，避免重复生成
  let cachedCaddyfile = null;
  let cachedRulesSignature = null;
  function rulesSignature() {
    return JSON.stringify(app.store.list());
  }
  function getCaddyfile() {
    const sig = rulesSignature();
    if (cachedCaddyfile === null || sig !== cachedRulesSignature) {
      cachedCaddyfile = generateCaddyfile(app.store.list(), config);
      cachedRulesSignature = sig;
    }
    return cachedCaddyfile;
  }

  // /api/rules 响应缓存（序列化 + gzip 复用，读多写少场景大幅提速）
  let rulesRespCache = { sig: null, json: null, gzip: null };
  function getRulesResp() {
    const sig = rulesSignature();
    if (rulesRespCache.sig !== sig) {
      rulesRespCache = { sig, json: JSON.stringify({ ok: true, rules: app.store.list() }), gzip: null };
    }
    return rulesRespCache;
  }
  function invalidateRulesCache() {
    rulesRespCache = { sig: null, json: null, gzip: null };
  }

  // ---------- 鉴权 ----------
  function authorized(req) {
    if (!config.authToken) return true;
    const h = req.headers['authorization'] || '';
    return h === `Bearer ${config.authToken}`;
  }

  // ---------- 状态 / 配置 ----------
  router.get('/api/status', async (req, res) => {
    const [version, running] = await Promise.all([caddyInstalled(config.caddyBin), caddyRunning(config.caddyBin)]);
    sendJson(req, res, 200, {
      ok: true,
      caddy: { installed: Boolean(version), version, running },
      config: {
        caddyfilePath: config.caddyfilePath,
        rulesFile: config.rulesFile,
        authEnabled: Boolean(config.authToken),
      },
      rulesCount: app.store.list().length,
      dns: {
        dynamicCount: app.store.list().filter((r) => r.dnsMode && r.dnsMode !== 'off').length,
        watchEnabled: Boolean(config.dnsWatchIntervalMs),
      },
    });
  });

  // ---------- Caddyfile 目标路径：自动定位 + 手动指定 ----------
  router.get('/api/config', async (req, res) => {
    const running = await detectRunningCaddyConfig();
    const candidates = config.caddyfilePathCandidates.map((c) => ({
      ...c,
      active: config.caddyfilePath === c.path,
    }));
    if (running && !candidates.some((c) => c.path === running)) {
      candidates.unshift({ path: running, source: 'running-caddy', active: config.caddyfilePath === running });
    }
    sendJson(req, res, 200, {
      ok: true,
      caddyfilePath: config.caddyfilePath,
      source: config.caddyfilePathSource,
      envOverridden: Boolean(process.env.CADDYFILE_PATH),
      runningCaddyConfig: running,
      fallbackEnabled: config.fallbackEnabled,
      fallbackStatus: config.fallbackStatus,
      candidates,
    });
  });

  router.put('/api/config/caddyfile-path', async (req, res) => {
    if (process.env.CADDYFILE_PATH) {
      return sendError(req, res, 400, '当前路径由环境变量 CADDYFILE_PATH 指定，请修改环境变量或先取消该变量');
    }
    const body = await readBody(req);
    const raw = String((body && body.path) || '').trim();
    if (raw && !path.isAbsolute(raw)) return sendError(req, res, 400, '路径必须是绝对路径');
    const next = raw ? path.resolve(raw) : '';
    if (next) {
      config.caddyfilePath = next;
      config.caddyfilePathSource = 'manual';
    } else {
      const auto = detectCaddyfileCandidates(config.dataDir);
      config.caddyfilePathCandidates = auto;
      config.caddyfilePath = auto[0].path;
      config.caddyfilePathSource = auto[0].source;
    }
    saveSettings(config.dataDir, { caddyfilePath: next });
    sendJson(req, res, 200, {
      ok: true,
      caddyfilePath: config.caddyfilePath,
      source: config.caddyfilePathSource,
    });
  });

  // ---------- Caddy 日志查看 ----------
  router.get('/api/logs', async (req, res, ctx) => {
    const sp = ctx.url.searchParams;
    const type = sp.get('type') === 'error' ? 'error' : 'access';
    const lines = Math.min(Math.max(Number(sp.get('lines')) || 200, 1), 2000);
    const q = (sp.get('q') || '').trim().toLowerCase();
    const file = type === 'error' ? config.caddyErrorLog : config.caddyAccessLog;
    const { ok, error, lines: rawLines } = await readLogTail(file, lines);
    if (!ok) return sendJson(req, res, 200, { ok: false, error, type, file, entries: [] });
    const entries = rawLines
      .map((raw) => parseCaddyLogLine(raw))
      .filter((e) => !q || (e.raw || '').toLowerCase().includes(q));
    sendJson(req, res, 200, { ok: true, type, file, entries });
  });

  router.put('/api/config/fallback', async (req, res) => {
    const body = await readBody(req);
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : config.fallbackEnabled;
    const status = Math.min(Math.max(Number(body.status) || config.fallbackStatus, 400), 599);
    config.fallbackEnabled = enabled;
    config.fallbackStatus = status;
    config.settings = { ...config.settings, fallbackEnabled: enabled, fallbackStatus: status };
    saveSettings(config.dataDir, config.settings);
    sendJson(req, res, 200, { ok: true, enabled, status });
  });

  router.get('/api/preview', (req, res) => {
    sendText(req, res, 200, getCaddyfile());
  });

  router.get('/api/rules', (req, res) => {
    const c = getRulesResp();
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      if (!c.gzip) c.gzip = zlib.gzipSync(c.json);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': c.gzip.length,
        'Cache-Control': 'no-store',
      });
      res.end(c.gzip);
    } else {
      sendText(req, res, 200, c.json, 'application/json; charset=utf-8');
    }
  });

  router.post('/api/rules', async (req, res) => {
    const body = await readBody(req);
    const r = app.store.create(body);
    if (!r.ok) return sendError(req, res, 400, r.error, { conflicts: r.conflicts });
    invalidateRulesCache();
    sendJson(req, res, 201, { ok: true, rule: r.rule });
  });

  router.get('/api/rules/:id', (req, res) => {
    const rule = app.store.get(req.params.id);
    if (!rule) return sendError(req, res, 404, '规则不存在');
    sendJson(req, res, 200, { ok: true, rule });
  });

  router.put('/api/rules/:id', async (req, res) => {
    const body = await readBody(req);
    const r = app.store.update(req.params.id, body);
    if (!r.ok) return sendError(req, res, r.error === '规则不存在' ? 404 : 400, r.error, { conflicts: r.conflicts });
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, rule: r.rule });
  });

  router.delete('/api/rules/:id', (req, res) => {
    const r = app.store.remove(req.params.id);
    if (!r.ok) return sendError(req, res, 404, r.error);
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, deleted: r.rule.id });
  });

  router.post('/api/rules/:id/toggle', (req, res) => {
    const r = app.store.toggle(req.params.id);
    if (!r.ok) return sendError(req, res, r.error === '规则不存在' ? 404 : 400, r.error, { conflicts: r.conflicts });
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, rule: r.rule });
  });

  // ---------- 应用配置 ----------
  router.post('/api/apply', async (req, res) => {
    const body = await readBody(req);
    const options = {
      dryRun: Boolean(body && body.dryRun),
      writeOnly: Boolean(body && body.writeOnly),
    };
    const result = await applyConfig({ config, rules: app.store.list(), options });
    const status = result.errors.length ? 400 : 200;
    sendJson(req, res, status, { ok: result.errors.length === 0, ...result, error: result.errors.join('\n') || undefined });
  });

  // ---------- 动态 DNS：解析 + 自动更新 + 热重载 ----------
  function sameIps(a, b) {
    return JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());
  }

  async function resolveHost(host, resolvers) {
    if (resolvers && resolvers.length) {
      const r = new dns.Resolver();
      r.setServers(resolvers);
      return await r.resolve4(host);
    }
    const res = await dns.promises.lookup(host, { all: true, verbatim: true });
    return res.map((x) => x.address);
  }

  async function refreshDynamicRules() {
    const now = new Date().toISOString();
    const changed = [];
    const errors = [];
    for (const r of app.store.list()) {
      if (!r.enabled || r.dnsMode !== 'manager') continue;
      const { host } = deriveUpstreamHostPort(r.upstream);
      const watchHost = r.dnsHost || host;
      if (!watchHost) continue;
      // 首次解析时把监听域名回写进规则，避免后续只 watch 到固化后的 IP
      const dnsHostPatch = r.dnsHost ? {} : { dnsHost: watchHost };
      try {
        const resolvers = r.dnsResolvers ? String(r.dnsResolvers).split(/[,\s]+/).filter(Boolean) : [];
        const ips = [...new Set(await resolveHost(watchHost, resolvers))].sort();
        const fmtIp = (ip) => (ip.includes(':') ? `[${ip}]` : ip);
        if (!sameIps(ips, r.resolvedIps || [])) {
          const { proto, port } = deriveUpstreamHostPort(r.upstream);
          if (proto && port) {
            const newUpstream = ips.map((ip) => `${proto}://${fmtIp(ip)}:${port}`).join(' ');
            const u = await app.store.update(r.id, {
              ...dnsHostPatch,
              upstream: newUpstream,
              resolvedIps: ips,
              lastCheckedAt: now,
              lastChangedAt: now,
              lastError: '',
            });
            if (!u.ok) errors.push({ id: r.id, name: r.name, host: watchHost, error: u.error });
            else changed.push({ id: r.id, name: r.name, host: watchHost, ips, upstream: newUpstream });
          }
        } else {
          const u = await app.store.update(r.id, { ...dnsHostPatch, resolvedIps: ips, lastCheckedAt: now, lastError: '' });
          if (!u.ok) errors.push({ id: r.id, name: r.name, host: watchHost, error: u.error });
        }
      } catch (err) {
        errors.push({ id: r.id, name: r.name, host: watchHost, error: String(err.message) });
        await app.store.update(r.id, { ...dnsHostPatch, lastCheckedAt: now, lastError: String(err.message).slice(0, 200) });
      }
    }
    let apply = null;
    if (changed.length) {
      apply = await applyConfig({ config, rules: app.store.list(), options: {} });
    }
    return { checkedAt: now, changed, errors, apply };
  }

  router.post('/api/refresh-dns', async (req, res) => {
    const r = await refreshDynamicRules();
    const failed = r.apply && r.apply.errors.length;
    sendJson(req, res, failed ? 400 : 200, { ok: !failed, ...r });
  });


  // ---------- 示例 ----------
  router.post('/api/examples', (req, res) => {
    const rules = app.store.replaceAll(exampleRules());
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, rules });
  });

  // ---------- 元信息（表单模板） ----------
  router.get('/api/meta', (req, res) => {
    sendJson(req, res, 200, {
      ok: true,
      defaultRule: defaultRule(),
      tlsModes: [
        { value: 'auto', label: '自动 HTTPS（Let\u2019s Encrypt 证书）' },
        { value: 'internal', label: '内网自签证书（tls internal）' },
        { value: 'off', label: '仅 HTTP（禁用自动证书）' },
      ],
    });
  });

  // ---------- 兜底错误页（未匹配任何路由时由 Caddy Manager 渲染，CF 风格） ----------
  function escHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function renderFallbackPage(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const xff = req.headers['x-forwarded-for'] || '';
    const userIp = (xff.split(',')[0] || '').trim() || req.socket.remoteAddress || '-';
    const status = config.fallbackStatus || 503;
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} · 未配置路由</title>
<style>
body{background:#111827;color:#e5e7eb;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:600px;text-align:center;padding:40px 24px}
.code{font-size:88px;font-weight:800;color:#f87171;line-height:1}
h1{font-size:20px;margin:18px 0 8px}
p{color:#9ca3af;font-size:13px;margin:6px 0}
.trace{display:flex;align-items:center;justify-content:center;gap:12px;margin:24px 0;flex-wrap:wrap}
.hop{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:10px 16px;font-size:12px;color:#9ca3af}
.hop b{display:block;color:#93c5fd;font-size:13px;margin-top:4px}
.arrow{color:#6b7280;font-size:18px}
.meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#6b7280}
a{color:#60a5fa}
</style></head>
<body><div class="card">
<div class="code">${status}</div>
<h1>没有匹配到任何转发规则</h1>
<p>请求的域名未配置路由，无法转发到后端服务。请管理员在 <b>Caddy Manager</b> 中为该域名添加转发规则。</p>
<div class="trace">
  <div class="hop">🌐 网络<b>${escHtml(userIp)}</b></div>
  <span class="arrow">→</span>
  <div class="hop">🖥 代理<b>${escHtml(os.hostname())}</b></div>
  <span class="arrow">→</span>
  <div class="hop">📦 服务主机<b>未匹配</b></div>
</div>
<p class="meta">${escHtml(req.method)} ${escHtml(url.pathname)} · ${escHtml(req.headers.host || '')} · ${escHtml(now)}</p>
</div></body></html>`;
    sendText(req, res, status, html, 'text/html; charset=utf-8');
  }

  // ---------- 静态资源 ----------
  let publicDir;
  try {
    publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
  } catch {
    publicDir = path.join(process.cwd(), 'public');
  }
  const staticRoute = staticHandler(publicDir, { embedded: embeddedAssets });

  // ---------- 统一入口 ----------
  const appHandler = async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const start = Date.now();
    const log = () => {
      if (config.quiet) return;
      console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - start}ms`);
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req)) {
          sendError(req, res, 401, '未授权：请提供正确的 Bearer Token');
          return log();
        }
        const handled = await router.handle(req, res, {});
        if (!handled) sendError(req, res, 404, '接口不存在');
        return log();
      }
      if (req.method === 'GET') {
        if (url.pathname === '/__fallback') {
          renderFallbackPage(req, res); // Caddy 兜底转发 -> 错误页
          return log();
        }
        if (staticRoute(req, res)) return log();
        sendError(req, res, 404, 'Not Found'); // 直接访问面板的未知路径
        return log();
      }
      sendError(req, res, 405, 'Method Not Allowed');
      log();
    } catch (err) {
      sendError(req, res, 500, `服务器内部错误: ${err.message}`);
      log();
    }
  };

  // ---------- DNS 看门狗（后台守护，供 server.js 启动） ----------
  appHandler.refreshDynamicRules = refreshDynamicRules;
  appHandler.startDnsWatcher = () => {
    if (appHandler._dnsTimer) return appHandler._dnsTimer;
    const tick = Math.max(1000, config.dnsWatchIntervalMs || 5000);
    appHandler._dnsTimer = setInterval(() => {
      refreshDynamicRules().catch((err) => console.error('[dns-watch] 扫描失败:', err.message));
    }, tick);
    appHandler._dnsTimer.unref();
    return appHandler._dnsTimer;
  };
  appHandler.stop = () => {
    if (appHandler._dnsTimer) {
      clearInterval(appHandler._dnsTimer);
      appHandler._dnsTimer = null;
    }
  };

  return appHandler;
}
