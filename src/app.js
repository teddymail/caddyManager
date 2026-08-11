import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { Router, sendJson, sendText, sendError, readBody, staticHandler } from './router.js';
import { Store } from './store.js';
import { generateCaddyfile } from './generator.js';
import { applyConfig, caddyInstalled, caddyRunning, detectRunningCaddyConfig, adminReload, run } from './caddy.js';
import { exampleRules, defaultRule, deriveUpstreamHostPort } from './util.js';
import { saveSettings, detectCaddyfileCandidates } from './config.js';
import { readLogTail, parseCaddyLogLine } from './logs.js';
import { listBackups, restoreBackup, backupDirFor } from './backups.js';
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

  // ---------- 权限自检 ----------
  function isWritable(fileOrDir) {
    try {
      fs.accessSync(path.dirname(fileOrDir), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
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
      permissions: {
        caddyfilePathWritable: isWritable(config.caddyfilePath),
        backupDir: backupDirFor(config.dataDir),
      },
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
      authTokenSource: config.authTokenSource,
      runningCaddyConfig: running,
      caddyAccessLog: config.caddyAccessLog,
      caddyErrorLog: config.caddyErrorLog,
      accessLogSource: config.accessLogSource,
      errorLogSource: config.errorLogSource,
      fallbackEnabled: config.fallbackEnabled,
      fallbackStatus: config.fallbackStatus,
      gatewayId: config.gatewayId,
      selfDomain: config.selfDomain,
      selfUpstream: config.selfUpstream,
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

  // ---------- 配置备份 / 回滚 ----------
  router.get('/api/backups', (req, res) => {
    sendJson(req, res, 200, { ok: true, backups: listBackups(config.dataDir), current: config.caddyfilePath });
  });

  router.post('/api/backups/:id/restore', async (req, res) => {
    try {
      const content = restoreBackup(config.dataDir, req.params.id, config.caddyfilePath);
      const ar = await adminReload(content);
      if (ar.ok) {
        sendJson(req, res, 200, { ok: true, restored: true, reloaded: true, target: config.caddyfilePath });
        return;
      }
      const r = await run(config.caddyBin, ['reload', '--config', config.caddyfilePath, '--adapter', 'caddyfile']);
      if (r.code === 0) {
        sendJson(req, res, 200, { ok: true, restored: true, reloaded: true, target: config.caddyfilePath });
      } else {
        sendJson(req, res, 200, {
          ok: true,
          restored: true,
          reloaded: false,
          target: config.caddyfilePath,
          error: `配置已恢复，但重载失败（${(r.stderr || '').trim() || '请手动 caddy reload'}）`,
        });
      }
    } catch (err) {
      sendError(req, res, 400, `恢复失败: ${err.message}`);
    }
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

  router.put('/api/config/log-paths', async (req, res) => {
    if (process.env.CADDY_ACCESS_LOG || process.env.CADDY_ERROR_LOG) {
      return sendError(req, res, 400, '当前日志路径由环境变量 CADDY_ACCESS_LOG / CADDY_ERROR_LOG 指定，请修改环境变量或先取消');
    }
    const body = await readBody(req);
    const access = String((body && body.access) || '').trim();
    const error = String((body && body.error) || '').trim();
    for (const p of [access, error]) {
      if (p && !path.isAbsolute(p)) return sendError(req, res, 400, '日志路径必须是绝对路径');
    }
    config.settings = { ...config.settings, caddyAccessLog: access, caddyErrorLog: error };
    saveSettings(config.dataDir, config.settings);
    config.caddyAccessLog = access ? path.resolve(access) : path.join(config.caddyLogDir, 'access.log');
    config.caddyErrorLog = error ? path.resolve(error) : path.join(config.caddyLogDir, 'error.log');
    config.accessLogSource = access ? 'manual' : 'auto';
    config.errorLogSource = error ? 'manual' : 'auto';
    sendJson(req, res, 200, {
      ok: true,
      caddyAccessLog: config.caddyAccessLog,
      caddyErrorLog: config.caddyErrorLog,
      accessLogSource: config.accessLogSource,
      errorLogSource: config.errorLogSource,
    });
  });

  router.put('/api/config/self-domain', async (req, res) => {
    const body = await readBody(req);
    const domain = String((body && body.domain) || '').trim().toLowerCase();
    if (domain && !/^[a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]*[a-z0-9\u4e00-\u9fa5])?(\.[a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]*[a-z0-9\u4e00-\u9fa5])?)+$/.test(domain)) {
      return sendError(req, res, 400, '域名格式不正确');
    }
    config.selfDomain = domain;
    config.settings = { ...config.settings, selfDomain: domain };
    saveSettings(config.dataDir, config.settings);
    sendJson(req, res, 200, { ok: true, selfDomain: domain, selfUpstream: config.selfUpstream });
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
    const r = await app.store.create(body);
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
    const r = await app.store.update(req.params.id, body);
    if (!r.ok) return sendError(req, res, r.error === '规则不存在' ? 404 : 400, r.error, { conflicts: r.conflicts });
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, rule: r.rule });
  });

  router.delete('/api/rules/:id', async (req, res) => {
    const r = await app.store.remove(req.params.id);
    if (!r.ok) return sendError(req, res, r.error === '规则不存在' ? 404 : 400, r.error);
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, deleted: r.rule.id });
  });

  router.post('/api/rules/:id/toggle', async (req, res) => {
    const r = await app.store.toggle(req.params.id);
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
  router.post('/api/examples', async (req, res) => {
    const r = await app.store.replaceAll(exampleRules());
    if (!r.ok) return sendError(req, res, 500, r.error);
    invalidateRulesCache();
    sendJson(req, res, 200, { ok: true, rules: r.rules });
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
  // ---------- 零信任网关错误页面（后端异常时显示三节点链路状态） ----------
  function renderGatewayErrorPage(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;
    const xff = req.headers['x-forwarded-for'] || '';
    const userIp = q.get('ip') || (xff.split(',')[0] || '').trim() || req.headers['x-real-ip'] || req.socket.remoteAddress || '-';
    const backendStatus = parseInt(q.get('status')) || 502;
    const originalHost = q.get('host') || req.headers.host || '-';
    const originalPath = q.get('path') || '/';
    const gatewayId = q.get('gateway_id') || req.headers['x-gateway-id'] || config.gatewayId || 'gw-' + Date.now().toString(36);
    const rawLogId = q.get('log_id') || req.headers['x-request-id'] || 'log-' + Math.random().toString(36).substr(2, 9);
    // 展示用短 ID：SHA-256 摘要取前 12 位十六进制；完整 ID 保留在 Caddy access log 与 X-Request-ID 中供对账
    const logId = createHash('sha256').update(rawLogId).digest('hex').slice(0, 12);
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    if (!config.quiet) console.log(`[gateway-trace] 追踪ID=${logId} 完整ID=${rawLogId} 网关=${gatewayId} status=${backendStatus} host=${originalHost} path=${originalPath}`);

    const statusText = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout'
    }[backendStatus] || 'Error';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${backendStatus} · ${statusText} · 零信任网关</title>
<style>
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
.container{max-width:880px;width:100%}
.header{text-align:center;margin-bottom:32px}
.gateway-badge{display:inline-flex;align-items:center;gap:6px;background:#1e293b;border:1px solid #334155;border-radius:20px;padding:6px 14px;font-size:12px;color:#94a3b8;margin-top:12px}
.gateway-badge svg{width:14px;height:14px}
.chain{display:flex;flex-direction:row;align-items:stretch;justify-content:center;gap:10px;margin:32px 0;flex-wrap:nowrap}
.node{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;text-align:center;background:#1e293b;border-radius:12px;padding:16px 14px;border:1px solid #334155}
.node.ok{border-color:#22c55e;background:rgba(34,197,94,0.1)}
.node.ok .node-status{color:#22c55e}
.node.error{border-color:#ef4444;background:rgba(239,68,68,0.1)}
.node.error .node-status{color:#ef4444}
.node-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:12px;flex-shrink:0}
.node.ok .node-icon{background:rgba(34,197,94,0.2)}
.node.error .node-icon{background:rgba(239,68,68,0.2)}
.node-content{flex:1;width:100%}
.node-name{font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.node-status{font-size:13px;margin-top:4px}
.node-meta{font-size:11px;color:#64748b;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:8px;word-break:break-all}
.connector{width:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.connector-line{color:#475569;font-size:22px;line-height:1;font-weight:600}
.connector-line::before{content:'→'}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;background:#1e293b;border-radius:12px;padding:16px;border:1px solid #334155}
.info-item{font-size:12px}
.info-label{color:#64748b;margin-bottom:4px}
.info-value{color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.footer{text-align:center;margin-top:24px;font-size:12px;color:#64748b}
@media(max-width:600px){
.node-name{font-size:16px}
.chain{flex-direction:column}
.connector{width:100%;height:24px;transform:rotate(90deg)}
.node{padding:12px 16px}
.node-icon{width:40px;height:40px;font-size:16px}
}
</style></head>
<body>
<div class="container">
  <div class="header">
    <div class="gateway-badge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Caddy Manager
    </div>
  </div>

  <div class="chain">
    <div class="node ok">
      <div class="node-icon">🌐</div>
      <div class="node-content">
        <div class="node-name">你</div>
        <div class="node-status">✓ 已正常</div>
        <div class="node-meta">${escHtml(userIp)}<br>${escHtml(os.hostname())}</div>
      </div>
    </div>

    <div class="connector"><div class="connector-line"></div></div>

    <div class="node ok">
      <div class="node-icon">🛡️</div>
      <div class="node-content">
        <div class="node-name">网关</div>
        <div class="node-status">✓ 正常</div>
        <div class="node-meta">Caddy Manager</div>
      </div>
    </div>

    <div class="connector"><div class="connector-line"></div></div>

    <div class="node error">
      <div class="node-icon">📦</div>
      <div class="node-content">
        <div class="node-name">服务</div>
        <div class="node-status">✗ ${backendStatus} ${statusText}</div>
      </div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-item">
      <div class="info-label">请求路径</div>
      <div class="info-value">${escHtml(originalPath)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">目标域名</div>
      <div class="info-value">${escHtml(originalHost)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">日志追踪 ID</div>
      <div class="info-value">${escHtml(logId)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">时间</div>
      <div class="info-value">${escHtml(now)}</div>
    </div>
  </div>

  <div class="footer">
    如需帮助，请联系管理员并提供日志追踪 ID<br>
    Powered by Caddy Manager
  </div>
</div>
</body></html>`;
    sendText(req, res, backendStatus, html, 'text/html; charset=utf-8');
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
        if (url.pathname === '/__gateway-error') {
          renderGatewayErrorPage(req, res); // 零信任网关错误页（后端异常）
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
