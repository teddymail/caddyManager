import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caddymanager-test-'));
const fakeCaddy = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-caddy');

const config = {
  ...loadConfig({}),
  host: '127.0.0.1',
  port: 0,
  dataDir: tmp,
  rulesFile: path.join(tmp, 'rules.json'),
  caddyfilePath: path.join(tmp, 'Caddyfile'),
  caddyBin: fakeCaddy,
  caddyReloadCmd: '',
  caddyStartCmd: '',
  authToken: '',
  globalTlsEmail: '',
};

let server;
let base;

before(async () => {
  const handler = createApp(config);
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('初始规则为空', async () => {
  const { status, data } = await call('GET', '/api/rules');
  assert.equal(status, 200);
  assert.deepEqual(data.rules, []);
});

test('创建规则（校验通过）', async () => {
  const { status, data } = await call('POST', '/api/rules', {
    name: '测试服务',
    domains: 'api.test.dev, www.test.dev',
    upstream: 'http://127.0.0.1:9000',
    tls: 'auto',
    path: '/api',
    healthPath: '/healthz',
  });
  assert.equal(status, 201);
  assert.ok(data.rule.id);
  assert.deepEqual(data.rule.domains, ['api.test.dev', 'www.test.dev']);
  assert.equal(data.rule.enabled, true);
});

test('创建规则（非法上游）返回 400', async () => {
  const { status, data } = await call('POST', '/api/rules', {
    name: 'bad', domains: ['x.com'], upstream: 'not-a-url',
  });
  assert.equal(status, 400);
  assert.match(data.error, /upstream/);
});

test('创建规则（非法域名）返回 400', async () => {
  const { status } = await call('POST', '/api/rules', {
    name: 'bad', domains: ['in valid!!'], upstream: 'http://127.0.0.1:1',
  });
  assert.equal(status, 400);
});

test('更新规则（部分字段）', async () => {
  const { data: { rule } } = await call('POST', '/api/rules', { name: 'u', domains: ['u.dev'], upstream: 'http://127.0.0.1:1' });
  const { status, data } = await call('PUT', `/api/rules/${rule.id}`, { upstream: 'http://127.0.0.1:9999' });
  assert.equal(status, 200);
  assert.equal(data.rule.upstream, 'http://127.0.0.1:9999');
  assert.equal(data.rule.name, 'u');
});

test('更新不存在的规则返回 404', async () => {
  const { status } = await call('PUT', '/api/rules/nope', { name: 'x' });
  assert.equal(status, 404);
});

test('切换启用状态', async () => {
  const { data: { rule } } = await call('POST', '/api/rules', { name: 't', domains: ['t.dev'], upstream: 'http://127.0.0.1:1' });
  const { data } = await call('POST', `/api/rules/${rule.id}/toggle`);
  assert.equal(data.rule.enabled, false);
});

test('删除规则', async () => {
  const { data: { rule } } = await call('POST', '/api/rules', { name: 'd', domains: ['d.dev'], upstream: 'http://127.0.0.1:1' });
  const { status } = await call('DELETE', `/api/rules/${rule.id}`);
  assert.equal(status, 200);
  const { data } = await call('GET', `/api/rules/${rule.id}`);
  assert.equal(data.error, '规则不存在');
});

test('预览返回生成的 Caddyfile', async () => {
  await call('POST', '/api/rules', { name: 'p', domains: ['p.dev'], upstream: 'http://127.0.0.1:1' });
  const res = await fetch(base + '/api/preview');
  const text = await res.text();
  assert.match(text, /p\.dev \{/);
});

test('应用配置：校验 → 写盘 → 重载', async () => {
  const { data } = await call('POST', '/api/apply', {});
  assert.equal(data.ok, true);
  assert.equal(data.validated, true);
  assert.equal(data.written, true);
  assert.equal(data.reloaded, true);
  const written = fs.readFileSync(config.caddyfilePath, 'utf8');
  assert.match(written, /reverse_proxy/);
});

test('dryRun 不写盘不重载', async () => {
  const beforeStat = fs.existsSync(config.caddyfilePath) ? fs.statSync(config.caddyfilePath).mtimeMs : 0;
  const { data } = await call('POST', '/api/apply', { dryRun: true });
  assert.equal(data.ok, true);
  assert.equal(data.validated, true);
  assert.equal(data.written, false);
  assert.equal(data.reloaded, false);
  const afterStat = fs.statSync(config.caddyfilePath).mtimeMs;
  assert.equal(afterStat, beforeStat);
});

test('writeOnly 跳过校验与重载', async () => {
  const { data } = await call('POST', '/api/apply', { writeOnly: true });
  assert.equal(data.ok, true);
  assert.equal(data.validated, false);
  assert.equal(data.written, true);
  assert.equal(data.reloaded, false);
});


// ---------- 动态 DNS ----------
test('refresh-dns：manager 模式规则自动解析并写回 resolvedIps', async () => {
  const { data: created } = await call('POST', '/api/rules', {
    name: '动态后端',
    domains: ['dyn.test'],
    upstream: 'http://localhost:18080',
    dnsMode: 'manager',
    dnsInterval: 30,
  });
  assert.equal(created.ok, true);
  const r1 = await call('POST', '/api/refresh-dns');
  assert.equal(r1.status, 200);
  // localhost 解析为 127.0.0.1 或 ::1
  const { data: detail } = await call('GET', `/api/rules/${created.rule.id}`);
  assert.ok(Array.isArray(detail.rule.resolvedIps) && detail.rule.resolvedIps.length > 0);
  assert.ok(detail.rule.lastCheckedAt);
  assert.match(detail.rule.upstream, /:\/\/[0-9a-f.:]+:18080/);
  // 再次刷新：无变化、不触发 apply
  const r2 = await call('POST', '/api/refresh-dns');
  assert.equal(r2.data.changed.length, 0);
});

// ---------- Caddyfile 目标路径：自动定位 + 手动指定 ----------
test('config: 读取当前路径并手动指定新路径', async () => {
  const g = await call('GET', '/api/config');
  assert.equal(g.status, 200);
  assert.ok(g.data.caddyfilePath);
  assert.ok(Array.isArray(g.data.candidates) && g.data.candidates.length > 0);

  const custom = path.join(tmp, 'custom', 'Caddyfile');
  const r = await call('PUT', '/api/config/caddyfile-path', { path: custom });
  assert.equal(r.status, 200);
  assert.equal(r.data.caddyfilePath, custom);
  assert.equal(r.data.source, 'manual');

  const g2 = await call('GET', '/api/config');
  assert.equal(g2.data.source, 'manual');
  assert.equal(g2.data.caddyfilePath, custom);

  // 恢复自动定位
  const r2 = await call('PUT', '/api/config/caddyfile-path', { path: '' });
  assert.equal(r2.status, 200);
  assert.notEqual(r2.data.source, 'manual');
});

test('config: 相对路径被拒绝', async () => {
  const r = await call('PUT', '/api/config/caddyfile-path', { path: 'relative/path' });
  assert.equal(r.status, 400);
});

// ---------- 鉴权 ----------
test('鉴权：设置 token 后无 token 请求被拒、带 token 通过', async () => {
  config.authToken = 'test-secret-123';
  const denied = await call('GET', '/api/rules');
  assert.equal(denied.status, 401);
  const res = await fetch(base + '/api/rules', { headers: { Authorization: 'Bearer test-secret-123' } });
  assert.equal(res.status, 200);
  config.authToken = '';
});

// ---------- 通配符域名 ----------
test('创建通配符域名规则', async () => {
  const { status, data } = await call('POST', '/api/rules', {
    name: '通配服务', domains: '*.example.com', upstream: 'http://127.0.0.1:8080', tls: 'auto',
  });
  assert.equal(status, 201);
  assert.deepEqual(data.rule.domains, ['*.example.com']);
});

// ---------- 冲突检测 ----------
test('冲突：同域名+同路径的启用规则被拒绝', async () => {
  await call('POST', '/api/rules', { name: 'A', domains: 'api.example.com', upstream: 'http://127.0.0.1:9001' });
  const r = await call('POST', '/api/rules', { name: 'B', domains: 'api.example.com', upstream: 'http://127.0.0.1:9002' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /冲突/);
  assert.ok(Array.isArray(r.data.conflicts) && r.data.conflicts.length === 1);
});

test('不冲突：精确域名与通配符可共存', async () => {
  const r = await call('POST', '/api/rules', { name: '精确', domains: 'api.example.com', upstream: 'http://127.0.0.1:9001', path: '/api' });
  const w = await call('POST', '/api/rules', { name: '通配', domains: '*.example.com', upstream: 'http://127.0.0.1:9002', path: '/api' });
  assert.equal(r.status, 201);
  assert.equal(w.status, 201);
});

test('不冲突：同域名不同路径', async () => {
  const a = await call('POST', '/api/rules', { name: 'p1', domains: 'x.example.com', upstream: 'http://127.0.0.1:9001', path: '/a' });
  const b = await call('POST', '/api/rules', { name: 'p2', domains: 'x.example.com', upstream: 'http://127.0.0.1:9002', path: '/b' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
});

test('不冲突：停用的规则不参与冲突检测', async () => {
  const r = await call('POST', '/api/rules', { name: 'off', domains: 'off.example.com', upstream: 'http://127.0.0.1:9001', enabled: false });
  assert.equal(r.status, 201);
  const r2 = await call('POST', '/api/rules', { name: 'on', domains: 'off.example.com', upstream: 'http://127.0.0.1:9002' });
  assert.equal(r2.status, 201);
});

test('冲突：编辑规则改成重复域名被拒绝', async () => {
  const a = await call('POST', '/api/rules', { name: 'E1', domains: 'e.example.com', upstream: 'http://127.0.0.1:9001' });
  const b = await call('POST', '/api/rules', { name: 'E2', domains: 'e2.example.com', upstream: 'http://127.0.0.1:9002' });
  const upd = await call('PUT', `/api/rules/${b.data.rule.id}`, { domains: 'e.example.com' });
  assert.equal(upd.status, 400);
  assert.match(upd.data.error, /冲突/);
  assert.equal(a.status, 201);
});

test('冲突：启用与已有启用的规则冲突时被拒绝', async () => {
  const x = await call('POST', '/api/rules', { name: 'T1', domains: 't.example.com', upstream: 'http://127.0.0.1:9001' });
  const y = await call('POST', '/api/rules', { name: 'T2', domains: 't.example.com', upstream: 'http://127.0.0.1:9002', enabled: false });
  assert.equal(y.status, 201); // 停用时可建
  const tog = await call('POST', `/api/rules/${y.data.rule.id}/toggle`);
  assert.equal(tog.status, 400);
  assert.match(tog.data.error, /冲突/);
  assert.equal(x.status, 201);
});
