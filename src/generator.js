/**
 * Caddyfile 生成器：把规则列表渲染成 Caddy v2 Caddyfile。
 *
 * 规则 -> 站点块规则：
 *   - tls = auto     -> 站点地址使用裸域名（自动 HTTPS + 自动证书）
 *   - tls = internal -> 站点地址使用裸域名 + `tls internal` 指令（内网自签）
 *   - tls = off      -> 站点地址加 `http://` 前缀（仅 HTTP，禁用自动 TLS）
 *   - path           -> 作为 reverse_proxy 的路径匹配器（如 /api/*）
 *   - stripPrefix    -> 与 path 搭配，追加 `uri strip_prefix`
 *   - healthPath     -> 在 reverse_proxy 块内追加健康检查选项
 *   - upstream       -> 支持多个地址（空格/逗号/换行分隔），多于 1 个时自动启用轮询负载均衡
 *   - extra          -> 原样追加的自定义指令（每行一条）
 */

import { deriveUpstreamHostPort } from './util.js';

function quote(s) {
  return /[\s{}"']/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

function siteAddresses(rule) {
  const prefix = rule.tls === 'off' ? 'http://' : '';
  return rule.domains.map((d) => `${prefix}${d}`).join(', ');
}

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

  // 匹配优先级排序：精确域名规则在前，通配符 (*.xxx.com) 规则在后（Caddy 本身精确优先，排序只为配置可读）
  const enabled = (rules || [])
    .filter((r) => r && r.enabled)
    .sort((a, b) => {
      const aWild = (a.domains || []).some((d) => d.startsWith('*.'));
      const bWild = (b.domains || []).some((d) => d.startsWith('*.'));
      return (aWild ? 1 : 0) - (bWild ? 1 : 0);
    });

  if (!enabled.length) {
    lines.push('');
    lines.push('# （暂无启用的规则）');
    return lines.join('\n') + '\n';
  }

  for (const rule of enabled) {
    lines.push('');
    lines.push(`${siteAddresses(rule)} {`);
    if (rule.tls === 'internal') {
      lines.push('    tls internal');
    }
    if (logsEnabled && opts.caddyAccessLog) {
      lines.push('    log {');
      lines.push(`        output file ${quote(opts.caddyAccessLog)}`);
      lines.push('        format json');
      lines.push('        level INFO');
      lines.push('    }');
    }
    if (rule.extra) {
      for (const l of String(rule.extra).split('\n')) {
        const t = l.trim();
        if (t) lines.push(`    ${t}`);
      }
    }
    const matcher = rule.path ? `${quote(rule.path)} ` : '';
    const blockOpts = [];
    if (rule.healthPath) {
      blockOpts.push(`health_uri ${quote(rule.healthPath)}`);
      blockOpts.push('health_interval 30s');
      blockOpts.push('health_timeout 5s');
    }
    if (rule.stripPrefix && rule.path) {
      blockOpts.push(`uri strip_prefix ${quote(rule.path)}`);
    }

    // 动态 DNS（Caddy 原生 dynamic a：A/AAAA 记录定时刷新，自动跟随 IP 变化）
    if (rule.dnsMode === 'caddy') {
      const { host, port } = deriveUpstreamHostPort(rule.upstream);
      const dnsHost = rule.dnsHost || host;
      if (dnsHost && port) {
        lines.push('    reverse_proxy {');
        lines.push(`        dynamic a ${quote(dnsHost)} ${port} {`);
        lines.push(`            refresh ${Number(rule.lookupInterval) || 60}s`);
        if (rule.dnsResolvers) {
          const rs = String(rule.dnsResolvers).split(/[,\s]+/).filter(Boolean);
          if (rs.length) lines.push(`            resolvers ${rs.join(' ')}`);
        }
        lines.push('            versions ipv4 ipv6');
        lines.push('        }');
        for (const o of blockOpts) lines.push(`        ${o}`);
        lines.push('    }');
        lines.push('}');
        continue;
      }
    }

    const upstreams = String(rule.upstream || '').split(/\s+/).filter(Boolean);
    const rp = [`    reverse_proxy ${matcher}${upstreams.join(' ')}`];
    // 转发头：携带用户 IP 等代理信息给上游（X-Forwarded-For 由 Caddy 按 trusted_proxies 规则自动追加）
    if (rule.forwardHeaders !== false) {
      blockOpts.push(`header_up X-Real-IP {http.request.remote.host}`);
      blockOpts.push(`header_up X-Forwarded-Proto {http.request.scheme}`);
      blockOpts.push(`header_up X-Forwarded-Host {http.request.host}`);
    }
    if (rule.trustProxy) blockOpts.push('trusted_proxies private_ranges');
    if (upstreams.length > 1) blockOpts.unshift('lb_policy round_robin');
    if (blockOpts.length) {
      lines.push(`${rp[0]} {`);
      for (const o of blockOpts) lines.push(`        ${o}`);
      lines.push('    }');
    } else {
      lines.push(rp[0]);
    }
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

