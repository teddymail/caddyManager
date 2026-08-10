import crypto from 'node:crypto';

/** 从 upstream 地址推导 { proto, host, port }。多地址取第一个；支持 IPv6 方括号。 */
export function deriveUpstreamHostPort(upstream) {
  const up = String(upstream || '').split(/\s+/)[0] || '';
  if (/^unix:/i.test(up)) return { proto: null, host: null, port: null };
  const m = up.match(/^(https?):\/\/([^/]*?)(?::(\d+))?(?:\/|$)/i);
  if (!m) return { proto: null, host: null, port: null };
  const proto = m[1].toLowerCase();
  const host = (m[2] || '').replace(/^\[|\]$/g, '');
  return { proto, host, port: m[3] || (proto === 'https' ? '443' : '80') };
}

export function randomId(prefix = 'r') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 校验并规整一条规则，返回 { ok, value } 或 { ok:false, error } */
export function normalizeRule(input, { partial = false } = {}) {
  const out = {};

  const err = (msg) => ({ ok: false, error: msg });

  const has = (k) => input[k] !== undefined && input[k] !== null && input[k] !== '';

  // name
  if (has('name')) {
    const name = String(input.name).trim();
    if (!name) return err('name 不能为空');
    if (name.length > 100) return err('name 最长 100 字符');
    out.name = name;
  } else if (!partial) return err('缺少 name');

  // domains
  if (has('domains')) {
    const raw = Array.isArray(input.domains) ? input.domains : [input.domains];
    const domains = raw
      .flatMap((d) => String(d).split(/[,\s]+/))
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (!domains.length) return err('domains 至少需要一个域名');
    for (const d of domains) {
      if (!/^(\*\.)?[a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]*[a-z0-9\u4e00-\u9fa5])?(\.[a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]*[a-z0-9\u4e00-\u9fa5])?)+$/.test(d)) {
        return err(`域名格式不正确: ${d}`);
      }
    }
    out.domains = [...new Set(domains)];
  } else if (!partial) return err('缺少 domains');

  // upstream（支持多个地址：空格/逗号/换行分隔）
  if (has('upstream')) {
    const parts = String(input.upstream).trim().split(/[,\s]+/).filter(Boolean);
    if (!parts.length) return err('upstream 不能为空');
    for (const up of parts) {
      if (!/^(https?:\/\/|unix:)/i.test(up)) {
        return err(`upstream 必须以 http:// 或 https:// 或 unix: 开头: ${up}`);
      }
      if (/^https?:\/\//i.test(up) && !/^https?:\/\/[^\s]+$/i.test(up)) {
        return err(`upstream 地址不合法: ${up}`);
      }
    }
    out.upstream = parts.join(' ');
  } else if (!partial) return err('缺少 upstream');

  // path（可选，必须以 / 开头，支持 * 通配）
  if (has('path')) {
    const p = String(input.path).trim();
    if (p && !p.startsWith('/')) return err('path 必须以 / 开头');
    out.path = p || '';
  }

  // stripPrefix
  if (has('stripPrefix')) out.stripPrefix = Boolean(input.stripPrefix);

  // tls
  if (has('tls')) {
    const tls = String(input.tls);
    if (!['auto', 'internal', 'off'].includes(tls)) return err('tls 只能是 auto / internal / off');
    out.tls = tls;
  }

  // healthPath（可选）
  if (has('healthPath')) {
    const hp = String(input.healthPath).trim();
    if (hp && !hp.startsWith('/')) return err('healthPath 必须以 / 开头');
    out.healthPath = hp || '';
  }

  // extra（可选原始指令）
  if (has('extra')) {
    const extra = String(input.extra).trim();
    if (extra.length > 2000) return err('extra 最长 2000 字符');
    out.extra = extra;
  }

  // enabled
  if (has('enabled')) out.enabled = Boolean(input.enabled);

  // 转发头：携带用户 IP 等代理信息给上游
  if (has('forwardHeaders')) out.forwardHeaders = Boolean(input.forwardHeaders);
  if (has('trustProxy')) out.trustProxy = Boolean(input.trustProxy);

  // 受保护规则（基础服务）：不可删除、不可停用
  if (has('protected')) out.protected = Boolean(input.protected);

  // ---------- 动态 DNS 相关 ----------
  if (has('dnsMode')) {
    const m = String(input.dnsMode);
    if (!['off', 'caddy', 'manager'].includes(m)) return err('dnsMode 只能是 off / caddy / manager');
    out.dnsMode = m;
  }
  if (has('dnsHost')) {
    const h = String(input.dnsHost).trim().toLowerCase();
    if (h && !/^[a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]*[a-z0-9\u4e00-\u9fa5])?(\.[a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]*[a-z0-9\u4e00-\u9fa5])?)*$/.test(h)) {
      return err(`dnsHost 主机名格式不正确: ${h}`);
    }
    out.dnsHost = h;
  }
  if (has('lookupInterval')) {
    const n = Number(input.lookupInterval);
    if (!Number.isFinite(n) || n < 1 || n > 86400) return err('lookupInterval 需在 1~86400 秒之间');
    out.lookupInterval = Math.round(n);
  }
  if (has('dnsInterval')) {
    const n = Number(input.dnsInterval);
    if (!Number.isFinite(n) || n < 1 || n > 86400) return err('dnsInterval 需在 1~86400 秒之间');
    out.dnsInterval = Math.round(n);
  }
  if (has('dnsResolvers')) {
    out.dnsResolvers = String(input.dnsResolvers).trim();
  }
  // 解析结果元数据（内部使用，允许透传）
  for (const k of ['resolvedIps', 'lastCheckedAt', 'lastChangedAt', 'lastError']) {
    if (has(k)) out[k] = input[k];
  }

  if (!partial && out.enabled === undefined) out.enabled = true;
  if (!partial && out.tls === undefined) out.tls = 'auto';
  if (!partial && out.forwardHeaders === undefined) out.forwardHeaders = true;
  if (!partial && out.trustProxy === undefined) out.trustProxy = false;

  return { ok: true, value: out };
}

export function defaultRule() {
  return {
    name: '',
    domains: [],
    upstream: 'http://127.0.0.1:8080',
    path: '',
    stripPrefix: false,
    tls: 'auto',
    healthPath: '',
    extra: '',
    enabled: true,
    dnsMode: 'off',
    dnsHost: '',
    forwardHeaders: true,
    trustProxy: false,
    lookupInterval: 60,
    dnsInterval: 60,
    dnsResolvers: '',
  };
}

/** 检测候选规则与已有「已启用」规则是否冲突。
 *  冲突定义：同域名 + 同路径 的两条启用规则（会互相覆盖/歧义）。
 *  精确域名 api.example.com 与通配符 *.example.com 可共存，不算冲突。
 *  返回冲突的已有规则列表。 */
export function findRuleConflicts(existingRules, candidate) {
  if (!candidate || candidate.enabled === false) return [];
  const normPath = (p) => (p == null ? '' : String(p));
  const conflicts = [];
  const candDomains = candidate.domains || [];
  const candPath = normPath(candidate.path);
  for (const r of existingRules) {
    if (!r.enabled) continue;
    if (r.id && candidate.id && r.id === candidate.id) continue;
    if (normPath(r.path) !== candPath) continue;
    const overlap = (r.domains || []).some((d) => candDomains.includes(d));
    if (overlap) {
      conflicts.push({ id: r.id, name: r.name, domains: r.domains, path: r.path });
    }
  }
  return conflicts;
}

/** 生成冲突提示文案。 */
export function conflictMessage(conflicts) {
  const parts = conflicts.map((c) => `「${c.name}」(${(c.domains || []).join(', ')})`);
  return `与已有规则冲突：${parts.join('、')}。同一域名+路径只能有一条启用的规则（精确域名与通配符 *.xxx.com 可共存）。`;
}

export function exampleRules() {
  return [
    {
      name: '示例 API 服务',
      domains: ['api.example.com'],
      upstream: 'http://127.0.0.1:8080',
      path: '',
      stripPrefix: false,
      tls: 'auto',
      healthPath: '/healthz',
      extra: '',
      enabled: true,
    },
    {
      name: '示例 Web 面板（仅 HTTP）',
      domains: ['panel.example.com'],
      upstream: 'http://127.0.0.1:3000',
      path: '/app',
      stripPrefix: true,
      tls: 'off',
      healthPath: '',
      extra: 'header Cache-Control "no-store"',
      enabled: false,
    },
    {
      name: '示例动态域名后端（dynamic a 自动跟随 IP）',
      domains: ['dyn.example.com'],
      upstream: 'http://dyn-backend.example.com:8080',
      path: '',
      stripPrefix: false,
      tls: 'auto',
      healthPath: '',
      extra: '',
      enabled: true,
      dnsMode: 'caddy',
      dnsHost: 'dyn-backend.example.com',
      lookupInterval: 60,
      dnsInterval: 60,
      dnsResolvers: '',
    },
  ];
}
