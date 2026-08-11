import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCaddyfile } from '../src/generator.js';

const base = {
  id: 'r1', name: 't', domains: ['api.example.com'],
  upstream: 'http://127.0.0.1:8080', path: '', stripPrefix: false,
  tls: 'auto', healthPath: '', extra: '', enabled: true,
};

test('tls=auto 使用裸域名（自动 HTTPS）', () => {
  const out = generateCaddyfile([base]);
  assert.match(out, /^api\.example\.com \{/m);
  assert.match(out, /reverse_proxy http:\/\/127\.0\.0\.1:8080/);
  assert.doesNotMatch(out, /http:\/\/api\.example\.com/);
});

test('tls=off 站点地址带 http:// 前缀', () => {
  const out = generateCaddyfile([{ ...base, tls: 'off' }]);
  assert.match(out, /^http:\/\/api\.example\.com \{/m);
});

test('tls=internal 输出 tls internal 指令', () => {
  const out = generateCaddyfile([{ ...base, tls: 'internal' }]);
  assert.match(out, /tls internal/);
});

test('多域名用逗号分隔', () => {
  const out = generateCaddyfile([{ ...base, domains: ['a.com', 'www.a.com'] }]);
  assert.match(out, /^a\.com, www\.a\.com \{/m);
});

test('path 生成 handle 子路径分流（精确 + 通配，同域名合并站点块）', () => {
  const out = generateCaddyfile([{ ...base, path: '/api' }]);
  assert.match(out, /handle \/api \{/);
  assert.match(out, /handle \/api\/\* \{/);
  assert.match(out, /reverse_proxy http:\/\/127\.0\.0\.1:8080/);
  assert.doesNotMatch(out, /reverse_proxy \/api http/);
});

test('同域名不同路径合并到同一站点块', () => {
  const out = generateCaddyfile([
    { ...base, domains: ['r.example.com'], upstream: 'http://127.0.0.1:8001', path: '' },
    { ...base, domains: ['r.example.com'], upstream: 'http://127.0.0.1:8002', path: '/api' },
  ]);
  // 只出现一个站点块头
  const heads = out.match(/r\.example\.com \{/g) || [];
  assert.equal(heads.length, 1);
  assert.match(out, /handle \/api \{/);
  assert.match(out, /handle \{/);
});

test('stripPrefix + path 输出 uri strip_prefix', () => {
  const out = generateCaddyfile([{ ...base, path: '/app', stripPrefix: true }]);
  assert.match(out, /uri strip_prefix \/app/);
});

test('healthPath 输出健康检查选项', () => {
  const out = generateCaddyfile([{ ...base, healthPath: '/healthz' }]);
  assert.match(out, /health_uri \/healthz/);
  assert.match(out, /health_interval 30s/);
});

test('extra 原样写入站点块', () => {
  const out = generateCaddyfile([{ ...base, extra: 'header X-Foo "bar"\nencode gzip' }]);
  assert.match(out, /header X-Foo "bar"/);
  assert.match(out, /encode gzip/);
});

test('disabled 规则不生成', () => {
  const out = generateCaddyfile([{ ...base, enabled: false }]);
  assert.doesNotMatch(out, /api\.example\.com \{/);
  assert.match(out, /暂无启用的规则/);
});

test('globalTlsEmail 写入全局块', () => {
  const out = generateCaddyfile([base], { globalTlsEmail: 'admin@example.com' });
  assert.match(out, /^\{\s*$/m);
  assert.match(out, /email admin@example\.com/);
});

test('空规则列表输出注释', () => {
  const out = generateCaddyfile([]);
  assert.match(out, /暂无启用的规则/);
});

test('多 upstream 输出多个目标并启用轮询负载均衡', () => {
  const out = generateCaddyfile([{ ...base, upstream: 'http://a:8080 http://b:8080' }]);
  assert.match(out, /reverse_proxy http:\/\/a:8080 http:\/\/b:8080 \{/);
  assert.match(out, /lb_policy round_robin/);
});

test('dnsMode=caddy 生成 dynamic a 动态上游', () => {
  const out = generateCaddyfile([{
    ...base, upstream: 'http://dyn-backend.example.com:8080',
    dnsMode: 'caddy', dnsHost: '', lookupInterval: 30, dnsResolvers: '',
  }]);
  assert.match(out, /dynamic a dyn-backend\.example\.com 8080 \{/);
  assert.match(out, /refresh 30s/);
  assert.doesNotMatch(out, /versions/); // 省略 versions，兼容旧版 Caddy
  assert.doesNotMatch(out, /reverse_proxy http:\/\/dyn-backend/);
});

test('dnsMode=caddy 显式 dnsHost 与自定义 resolver', () => {
  const out = generateCaddyfile([{
    ...base, upstream: 'http://old.example.com:9000',
    dnsMode: 'caddy', dnsHost: 'new.example.com', lookupInterval: 10,
    dnsResolvers: '8.8.8.8, 1.1.1.1',
  }]);
  assert.match(out, /dynamic a new\.example\.com 9000/);
  assert.match(out, /resolvers 8\.8\.8\.8 1\.1\.1\.1/);
  assert.match(out, /refresh 10s/);
});

test('通配符域名生成 *.example.com 站点块', () => {
  const out = generateCaddyfile([{ ...base, domains: ['*.example.com'] }]);
  assert.match(out, /^\*\.example\.com \{/m);
});

test('精确域名规则排在通配符规则之前', () => {
  const out = generateCaddyfile([
    { ...base, id: 'wild', name: 'wild', domains: ['*.example.com'], upstream: 'http://127.0.0.1:9002' },
    { ...base, id: 'exact', name: 'exact', domains: ['api.example.com'], upstream: 'http://127.0.0.1:9001' },
  ]);
  const exactIdx = out.indexOf('api.example.com {');
  const wildIdx = out.indexOf('*.example.com {');
  assert.ok(exactIdx !== -1 && wildIdx !== -1);
  assert.ok(exactIdx < wildIdx, '精确规则必须先生成');
});

test('配置日志路径后注入 access/error 日志', () => {
  const out = generateCaddyfile([{ ...base }], {
    globalTlsEmail: '',
    caddyAccessLog: '/var/log/caddy/access.log',
    caddyErrorLog: '/var/log/caddy/error.log',
    logsEnabled: true,
  });
  assert.match(out, /output file \/var\/log\/caddy\/error\.log/);
  assert.match(out, /output file \/var\/log\/caddy\/access\.log/);
  assert.match(out, /format json/);
});

test('logsEnabled=false 时不注入日志', () => {
  const out = generateCaddyfile([{ ...base }], {
    caddyAccessLog: '/var/log/caddy/access.log',
    caddyErrorLog: '/var/log/caddy/error.log',
    logsEnabled: false,
  });
  assert.doesNotMatch(out, /output file/);
});

test('forwardHeaders 默认生成 X-Real-IP/X-Forwarded-* 转发头', () => {
  const out = generateCaddyfile([{ ...base, forwardHeaders: true, trustProxy: false }]);
  assert.match(out, /header_up X-Real-IP \{http\.request\.remote\.host\}/);
  assert.match(out, /header_up X-Forwarded-Proto \{http\.request\.scheme\}/);
  assert.match(out, /header_up X-Forwarded-Host \{http\.request\.host\}/);
  assert.doesNotMatch(out, /trusted_proxies/);
});

test('trustProxy 生成 trusted_proxies private_ranges', () => {
  const out = generateCaddyfile([{ ...base, forwardHeaders: true, trustProxy: true }]);
  assert.match(out, /trusted_proxies private_ranges/);
});

test('forwardHeaders=false 不生成转发头', () => {
  const out = generateCaddyfile([{ ...base, forwardHeaders: false, trustProxy: false }]);
  assert.doesNotMatch(out, /header_up X-Real-IP/);
});

test('fallbackEnabled 生成默认兜底站点（转发到 Caddy Manager）', () => {
  const out = generateCaddyfile([{ ...base }], {
    fallbackEnabled: true,
    fallbackTarget: 'http://127.0.0.1:8888',
  });
  assert.match(out, /^:80 \{/m);
  assert.match(out, /reverse_proxy http:\/\/127\.0\.0\.1:8888/);
  assert.match(out, /header_up X-Real-IP/);
});

test('fallbackEnabled=false 不生成兜底站点', () => {
  const out = generateCaddyfile([{ ...base }], { fallbackEnabled: false, fallbackTarget: 'http://127.0.0.1:8888' });
  assert.doesNotMatch(out, /^:80 \{/m);
});

test('selfDomain 系统保护规则：空规则列表也注入，指向自身', () => {
  const out = generateCaddyfile([], { selfDomain: 'panel.example.com', selfUpstream: 'http://127.0.0.1:8888' });
  assert.match(out, /panel\.example\.com \{/);
  assert.match(out, /reverse_proxy http:\/\/127\.0\.0\.1:8888/);
});

test('selfDomain 系统保护规则：用户同域名规则被接管', () => {
  const out = generateCaddyfile(
    [{ ...base, domains: ['panel.example.com'], upstream: 'http://127.0.0.1:9999' }],
    { selfDomain: 'panel.example.com', selfUpstream: 'http://127.0.0.1:8888' }
  );
  assert.match(out, /reverse_proxy http:\/\/127\.0\.0\.1:8888/);
  assert.doesNotMatch(out, /reverse_proxy http:\/\/127\.0\.0\.1:9999/);
});

test('不配置 selfDomain 时不注入系统规则', () => {
  const out = generateCaddyfile([], {});
  assert.doesNotMatch(out, /panel\.example\.com/);
});

// ---------- 零信任网关错误页 ----------
test('零信任网关：注入 /__gateway-error 路由与 handle_response 4xx/5xx 拦截', () => {
  const out = generateCaddyfile([base], { selfUpstream: 'http://127.0.0.1:8888' });
  assert.match(out, /handle \/__gateway-error \{/);
  assert.match(out, /handle_errors \{/);
  assert.match(out, /@4xx status 400 /);
  assert.match(out, /@5xx status 500 /);
  assert.match(out, /handle_response @4xx \{/);
  assert.match(out, /handle_response @5xx \{/);
  assert.match(out, /rewrite \* \/__gateway-error\?status=\{rp\.status_code\}/);
  assert.match(out, /rewrite \* \/__gateway-error\?status=\{http\.error\.status_code\}/);
  // 追踪参数：状态/上游/域名/路径/IP/日志ID/网关ID 随重写传递
  assert.match(out, /status=\{rp\.status_code\}/);
  assert.match(out, /upstream=\{http\.reverse_proxy\.upstream\.host\}/);
  assert.match(out, /host=\{http\.request\.host\}/);
  assert.match(out, /path=\{http\.request\.uri\.path\}/);
  assert.match(out, /ip=\{http\.request\.remote\.host\}/);
  assert.match(out, /log_id=\{http\.request\.uuid\}/);
  assert.match(out, /gateway_id=caddymanager/);
});

test('零信任网关：转发头携带网关 ID 与请求日志 ID', () => {
  const out = generateCaddyfile([base], { selfUpstream: 'http://127.0.0.1:8888' });
  assert.match(out, /header_up X-Gateway-ID "caddymanager"/);
  assert.match(out, /header_up X-Request-ID \{http\.request\.uuid\}/);
});

test('零信任网关：GATEWAY_ID 可配置，注入 header 与追踪参数（含兜底站点）', () => {
  const out = generateCaddyfile([base], { selfUpstream: 'http://127.0.0.1:8888', fallbackTarget: 'http://127.0.0.1:8888', gatewayId: 'gw-shanghai-1' });
  assert.match(out, /header_up X-Gateway-ID "gw-shanghai-1"/);
  assert.match(out, /gateway_id=gw-shanghai-1/);
  assert.doesNotMatch(out, /gateway_id=caddymanager/);
  // 兜底 :80 站点同样携带网关 ID 与请求日志 ID
  assert.match(out, /:80 \{[\s\S]*header_up X-Gateway-ID "gw-shanghai-1"[\s\S]*header_up X-Request-ID \{http\.request\.uuid\}/);
});

test('零信任网关：forwardHeaders=false 时不注入追踪头', () => {
  const out = generateCaddyfile([{ ...base, forwardHeaders: false }], { selfUpstream: 'http://127.0.0.1:8888' });
  // 规则代理块不注入追踪头；仅错误页路由 / handle_errors / handle_response 4xx+5xx（内部管道）各保留一份
  assert.equal((out.match(/X-Gateway-ID/g) || []).length, 4);
  assert.equal((out.match(/X-Request-ID/g) || []).length, 4);
});

test('零信任网关：未配置 selfUpstream/fallbackTarget 时不注入错误页路由', () => {
  const out = generateCaddyfile([base]);
  assert.doesNotMatch(out, /__gateway-error/);
  assert.doesNotMatch(out, /handle_response/);
  assert.doesNotMatch(out, /handle_errors/);
});

test('零信任网关：系统保护规则（面板自身）不做错误拦截', () => {
  const out = generateCaddyfile([], { selfDomain: 'panel.example.com', selfUpstream: 'http://127.0.0.1:8888' });
  assert.match(out, /panel\.example\.com \{/);
  assert.doesNotMatch(out, /__gateway-error/);
  assert.doesNotMatch(out, /handle_response/);
  assert.doesNotMatch(out, /handle_errors/);
});

test('零信任网关：动态 DNS 规则同样注入错误拦截', () => {
  const out = generateCaddyfile([{
    ...base, upstream: 'http://dyn-backend.example.com:8080',
    dnsMode: 'caddy', dnsHost: '', lookupInterval: 30, dnsResolvers: '8.8.8.8, 1.1.1.1',
  }], { selfUpstream: 'http://127.0.0.1:8888' });
  assert.match(out, /handle_response @5xx \{/);
  assert.match(out, /resolvers 8\.8\.8\.8 1\.1\.1\.1/);
});
