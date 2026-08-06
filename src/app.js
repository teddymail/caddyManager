import path from 'node:path';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { Router, sendJson, sendText, sendError, readBody, staticHandler } from './router.js';
import { Store } from './store.js';
import { generateCaddyfile } from './generator.js';
import { applyConfig, caddyInstalled, caddyRunning } from './caddy.js';
import { exampleRules, defaultRule, deriveUpstreamHostPort } from './util.js';
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
    if (!r.ok) return sendError(req, res, 400, r.error);
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
    if (!r.ok) return sendError(req, res, r.error === '规则不存在' ? 404 : 400, r.error);
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
    if (!r.ok) return sendError(req, res, 404, r.error);
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
        staticRoute(req, res);
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
