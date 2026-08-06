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

test('path 作为 reverse_proxy 路径匹配器', () => {
  const out = generateCaddyfile([{ ...base, path: '/api' }]);
  assert.match(out, /reverse_proxy \/api http:\/\/127\.0\.0\.1:8080/);
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
  assert.match(out, /versions ipv4 ipv6/);
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
