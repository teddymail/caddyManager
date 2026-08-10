import { deriveUpstreamHostPort } from './util.js';

function quote(s) {
  return /[\s{}"']/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

function siteAddresses(rule) {
  const prefix = rule.tls === 'off' ? 'http://' : '';
  return rule.domains.map((d) => `${prefix}${d}`).join(', ');
}

function upstreamList(rule) {
  return String(rule.upstream || '').split(/\s+/).filter(Boolean);
}

/** path 转 handle 匹配：/api 需要同时匹配精确 /api 和前缀 /api/*。 */
function handlePaths(p) {
  if (!p) return [];
  if (p.endsWith('/*')) return [p];
  return [p, `${p}/*`];
}

/** reverse_proxy 块内选项（不含 path matcher，路径由 handle 承担）。 */
function reverseProxyBlockOptions(rule) {
  const upstreams = upstreamList(rule);
  const blockOpts = [];
  if (rule.healthPath) {
    blockOpts.push(`health_uri ${quote(rule.healthPath)}`);
    blockOpts.push('health_interval 30s');
    blockOpts.push('health_timeout 5s');
  }
  if (rule.forwardHeaders !== false) {
    blockOpts.push(`header_up X-Real-IP {http.request.remote.host}`);
    blockOpts.push(`header_up X-Forwarded-Proto {http.request.scheme}`);
    blockOpts.push(`header_up X-Forwarded-Host {http.request.host}`);
  }
  if (rule.trustProxy) blockOpts.push('trusted_proxies private_ranges');
  if (upstreams.length > 1) blockOpts.unshift('lb_policy round_robin');
  return blockOpts;
}

/** 渲染一条规则的 reverse_proxy（普通或 dynamic a），写入 handle 块内（缩进 8 空格）。 */
function renderReverseProxy(rule, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 4);
  const upstreams = upstreamList(rule);
  const blockOpts = reverseProxyBlockOptions(rule);

  if (rule.dnsMode === 'caddy') {
    const { host, port } = deriveUpstreamHostPort(rule.upstream);
    const dnsHost = rule.dnsHost || host;
    if (!dnsHost || !port) return [];
    const lines = [`${pad}reverse_proxy {`];
    lines.push(`${inner}dynamic a ${quote(dnsHost)} ${port} {`);
    lines.push(`${inner}    refresh ${Number(rule.lookupInterval) || 60}s`);
    if (rule.dnsResolvers) {
      const rs = String(rule.dnsResolvers).split(/[,\s]+/).filter(Boolean);
      if (rs.length) lines.push(`${inner}    resolvers ${rs.join(' ')}`);
    }
    // 省略 versions（兼容旧版 Caddy，默认即 ipv4+ipv6）
    lines.push(`${inner}}`);
    for (const o of blockOpts) lines.push(`${inner}${o}`);
    lines.push(`${pad}}`);
    return lines;
  }

  const lines = [`${pad}reverse_proxy ${upstreams.join(' ')} {`];
  for (const o of blockOpts) lines.push(`${inner}${o}`);
  lines.push(`${pad}}`);
  return lines;
}

/**
 * Caddyfile 生成器：
 *  - 同域名的多条规则合并到同一个站点块，用 handle 按路径分流（Caddy 不允许同 host 定义多个站点块）
 *  - 有 path 的规则在前（更具体），无 path 的规则作为兜底放最后
 *  - 系统保护规则（selfDomain）始终注入
 */
export function generateCaddyfile(rules, opts = {}) {
  const lines = [];
  lines.push('# 本文件由 Caddy Manager 自动生成，请勿手动编辑。');
  lines.push(`# 生成时间: ${new Date().toISOString()}`);

  const globalEmail = (opts.globalTlsEmail || '').trim();
  const logsEnabled = opts.logsEnabled !== false;
  if (globalEmail || (logsEnabled && opts.caddyErrorLog)) {
    lines.push('');
    lines.push('{');
    if (globalEmail) lines.push(`    email ${quote(globalEmail)}`);
    if (logsEnabled && opts.caddyErrorLog) {
      lines.push('    log {');
      lines.push(`        output file ${quote(opts.caddyErrorLog)}`);
      lines.push('        format json');
      lines.push('        level WARN');
      lines.push('    }');
    }
    lines.push('}');
  }

  // 匹配优先级排序：精确域名规则在前，通配符 (*.xxx.com) 规则在后
  const enabled = (rules || [])
    .filter((r) => r && r.enabled)
    .sort((a, b) => {
      const aWild = (a.domains || []).some((d) => d.startsWith('*.'));
      const bWild = (b.domains || []).some((d) => d.startsWith('*.'));
      return (aWild ? 1 : 0) - (bWild ? 1 : 0);
    });

  // 系统保护规则：面板自身域名始终代理到本服务（不存规则库，用户无法删除/覆盖），防止自锁死
  const sysDomain = (opts.selfDomain || '').trim().toLowerCase();
  if (sysDomain) {
    const sysRule = {
      id: '__system_self__',
      name: 'Caddy Manager 自身（系统保护）',
      domains: [sysDomain],
      upstream: opts.selfUpstream || `http://127.0.0.1:${opts.port || 8888}`,
      tls: 'auto',
      path: '',
      stripPrefix: false,
      healthPath: '',
      extra: '',
      enabled: true,
      forwardHeaders: true,
      trustProxy: false,
      protected: true,
    };
    const filtered = enabled.filter((r) => !(r.domains || []).includes(sysDomain));
    enabled.length = 0;
    enabled.push(...filtered, sysRule);
  }

  if (!enabled.length) {
    lines.push('');
    lines.push('# （暂无启用的规则）');
  }

  // 按域名集合分组：同域名的规则合并到同一站点块（避免 Caddy ambiguous site definition）
  const groups = new Map();
  for (const rule of enabled) {
    const key = [...rule.domains].sort().join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }

  for (const group of groups.values()) {
    // 组内排序：有路径的在前（更具体），无路径的兜底放最后
    const sorted = [...group].sort((a, b) => (a.path ? 0 : 1) - (b.path ? 0 : 1));
    const first = sorted[0];
    lines.push('');
    lines.push(`${siteAddresses(first)} {`);
    if (first.tls === 'internal') lines.push('    tls internal');
    if (logsEnabled && opts.caddyAccessLog) {
      lines.push('    log {');
      lines.push(`        output file ${quote(opts.caddyAccessLog)}`);
      lines.push('        format json');
      lines.push('        level INFO');
      lines.push('    }');
    }
    if (first.extra) {
      for (const l of String(first.extra).split('\n')) {
        const t = l.trim();
        if (t) lines.push(`    ${t}`);
      }
    }

    sorted.forEach((rule, i) => {
      const isLast = i === sorted.length - 1;
      const isDynamic = rule.dnsMode === 'caddy';
      if (rule.path) {
        // 有路径：handle 精确 + 通配（覆盖 /api 与 /api/*）
        for (const hp of handlePaths(rule.path)) {
          lines.push(`    handle ${quote(hp)} {`);
          if (rule.stripPrefix) lines.push(`        uri strip_prefix ${quote(rule.path)}`);
          lines.push(...renderReverseProxy(rule, 8));
          lines.push('    }');
        }
      } else if (sorted.length > 1) {
        // 组内有多条规则：无路径的作为兜底 handle
        lines.push('    handle {');
        lines.push(...renderReverseProxy(rule, 8));
        lines.push('    }');
      } else if (isDynamic) {
        // 单条 dynamic a：直接块内 reverse_proxy
        lines.push(...renderReverseProxy(rule, 4));
      } else {
        // 单条普通规则：直接块内 reverse_proxy（无 handle 包裹，保持简洁）
        const upstreams = upstreamList(rule);
        const blockOpts = reverseProxyBlockOptions(rule);
        lines.push(`    reverse_proxy ${upstreams.join(' ')} {`);
        for (const o of blockOpts) lines.push(`        ${o}`);
        lines.push('    }');
      }
    });
    lines.push('}');
  }

  // 默认兜底：未匹配任何规则的请求 -> 转发到 Caddy Manager 的 /__fallback（渲染 503 错误页）
  if (opts.fallbackEnabled !== false && opts.fallbackTarget) {
    lines.push('');
    lines.push(':80 {');
    lines.push('    rewrite * /__fallback');
    lines.push(`    reverse_proxy ${quote(opts.fallbackTarget)} {`);
    lines.push('        trusted_proxies private_ranges');
    lines.push('        header_up X-Real-IP {http.request.remote.host}');
    lines.push('    }');
    lines.push('}');
  }

  lines.push('');
  return lines.join('\n');
}
