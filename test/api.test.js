import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

// 迷你 UDP DNS 服务器：固定返回 A 记录，用于测试自定义 resolver 路径
function startFakeDns(answers) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const id = msg.readUInt16BE(0);
    let off = 12;
    const labels = [];
    while (off < msg.length) {
      const len = msg[off++];
      if (len === 0) break;
      labels.push(msg.subarray(off, off + len).toString('ascii'));
      off += len;
    }
    const qtype = msg.readUInt16BE(off);
    const qclass = msg.readUInt16BE(off + 2);
    const qname = labels.join('.');
    const ips = answers[qname] || ['127.0.0.9'];

    const res = Buffer.alloc(512);
    res.writeUInt16BE(id, 0);
    res.writeUInt16BE(0x8180, 2);
    res.writeUInt16BE(1, 4);
    res.writeUInt16BE(ips.length, 6);
    let o = 12;
    for (const l of labels) { res.writeUInt8(l.length, o++); res.write(l, o, 'ascii'); o += l.length; }
    res.writeUInt8(0, o++);
    res.writeUInt16BE(qtype, o); o += 2;
    res.writeUInt16BE(qclass, o); o += 2;
    for (const ip of ips) {
      res.writeUInt16BE(0xc00c, o); o += 2;   // 指针指向问题名
      res.writeUInt16BE(1, o); o += 2;        // A
      res.writeUInt16BE(1, o); o += 2;        // IN
      res.writeUInt32BE(30, o); o += 4;       // TTL
      res.writeUInt16BE(4, o); o += 2;        // RDLENGTH
      for (const p of ip.split('.').map(Number)) res.writeUInt8(p, o++);
    }
    socket.send(res.subarray(0, o), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => resolve({ socket, port: socket.address().port }));
  });
}

test('refresh-dns：manager 模式 + 自定义 resolver（回归：dns.Resolver 需用 promises 版）', async () => {
  const dnsServer = await startFakeDns({ 'dynresolver.test': ['127.0.0.9'] });
  try {
    const { data: created } = await call('POST', '/api/rules', {
      name: '动态后端-自定义DNS',
      domains: ['dynresolver.test'],
      upstream: 'http://dynresolver.test:18081',
      dnsMode: 'manager',
      dnsHost: 'dynresolver.test',
      dnsResolvers: `127.0.0.1:${dnsServer.port}`,
      dnsInterval: 30,
    });
    assert.equal(created.ok, true);
    const r1 = await call('POST', '/api/refresh-dns');
    assert.equal(r1.status, 200);
    // 修复前：dns.Resolver.resolve4 缺回调会抛 "callback argument must be of type function"
    assert.ok(!r1.data.errors.some((e) => /callback/i.test(e.error)), `不应出现 callback 类型错误: ${JSON.stringify(r1.data.errors)}`);
    assert.equal(r1.data.changed.length, 1);
    const { data: detail } = await call('GET', `/api/rules/${created.rule.id}`);
    assert.deepEqual(detail.rule.resolvedIps, ['127.0.0.9']);
    assert.match(detail.rule.upstream, /127\.0\.0\.9:18081/);
  } finally {
    dnsServer.socket.close();
  }
});

test('refresh-dns：应用失败时规则不落盘、下轮自动重试（看门狗不卡死）', async () => {
  const dnsServer = await startFakeDns({ 'dynfail.test': ['127.0.0.9'] });
  let ruleId;
  try {
    const { data: created } = await call('POST', '/api/rules', {
      name: '动态后端-生效失败',
      domains: ['dynfail.test'],
      upstream: 'http://dynfail.test:18082',
      dnsMode: 'manager',
      dnsHost: 'dynfail.test',
      dnsResolvers: `127.0.0.1:${dnsServer.port}`,
      dnsInterval: 30,
    });
    assert.equal(created.ok, true);
    ruleId = created.rule.id;

    // 模拟生效失败：fake-caddy reload/start 全部失败
    process.env.FAKE_FAIL = '1';
    try {
      const r1 = await call('POST', '/api/refresh-dns');
      assert.equal(r1.status, 400);
      // 关键断言：生效失败后规则保持原状（upstream 仍是域名、未记录 resolvedIps），避免下次扫描误判“无变化”而卡死
      assert.equal(r1.data.changed.length, 0);
      assert.ok(r1.data.error && /失败/.test(r1.data.error), `应返回可读错误: ${r1.data.error}`);
      const { data: afterFail } = await call('GET', `/api/rules/${ruleId}`);
      assert.equal(afterFail.rule.upstream, 'http://dynfail.test:18082');
      assert.equal(afterFail.rule.resolvedIps, undefined);
      assert.ok(afterFail.rule.lastError, '生效失败原因应记录到 lastError 供面板展示');
    } finally {
      delete process.env.FAKE_FAIL;
    }

    // 生效恢复后：下一轮扫描自动重试并成功改写
    const r2 = await call('POST', '/api/refresh-dns');
    assert.equal(r2.status, 200);
    assert.equal(r2.data.changed.length, 1);
    const { data: afterOk } = await call('GET', `/api/rules/${ruleId}`);
    assert.ok(Array.isArray(afterOk.rule.resolvedIps) && afterOk.rule.resolvedIps.length > 0);
    assert.match(afterOk.rule.upstream, /:\/\/[0-9a-f.:]+:18082/);
    // 回归：解析恢复成功后 lastError 应被清空，而不是残留旧错误
    assert.equal(afterOk.rule.lastError, '');
  } finally {
    dnsServer.socket.close();
  }
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

// ---------- Caddy 日志查看 ----------
test('logs: 读取并解析 access 日志', async () => {
  const logFile = path.join(tmp, 'access.log');
  const lines = [
    JSON.stringify({ ts: 1786000000.123, level: 'info', status: 200, duration: 0.012, request: { method: 'GET', uri: '/api/hello', host: 'api.example.com', remote_ip: '1.2.3.4' } }),
    JSON.stringify({ ts: 1786000001.5, level: 'info', status: 502, duration: 0.5, request: { method: 'POST', uri: '/x', host: 'api.example.com' } }),
    'not-json-line',
  ];
  fs.writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');
  config.caddyAccessLog = logFile;
  config.caddyErrorLog = path.join(tmp, 'error.log');
  const r = await call('GET', '/api/logs?type=access&lines=50');
  assert.equal(r.status, 200);
  assert.ok(r.data.entries.length >= 3);
  const parsed = r.data.entries.filter((e) => e.parsed);
  assert.ok(parsed.length >= 2);
  const first = parsed.find((e) => e.request.uri === '/api/hello');
  assert.equal(first.status, 200);
  assert.equal(first.request.host, 'api.example.com');
  // 关键词过滤
  const f = await call('GET', '/api/logs?type=access&q=502');
  assert.ok(f.data.entries.every((e) => e.raw.includes('502')));
});

// ---------- 转发头 ----------
test('规则默认开启转发头、可关信任代理', async () => {
  const r = await call('POST', '/api/rules', { name: 'hdr', domains: 'hdr.example.com', upstream: 'http://127.0.0.1:9001' });
  assert.equal(r.status, 201);
  assert.equal(r.data.rule.forwardHeaders, true);
  assert.equal(r.data.rule.trustProxy, false);
  const r2 = await call('POST', '/api/rules', { name: 'hdr2', domains: 'hdr2.example.com', upstream: 'http://127.0.0.1:9002', trustProxy: true, forwardHeaders: false });
  assert.equal(r2.status, 201);
  assert.equal(r2.data.rule.trustProxy, true);
  assert.equal(r2.data.rule.forwardHeaders, false);
});

// ---------- 默认兜底 ----------
test('Caddy 兜底路径 /__fallback 返回 503 错误页（含用户 IP 与链路）', async () => {
  const res = await fetch(base + '/__fallback', {
    headers: { 'X-Forwarded-For': '8.8.4.4' },
  });
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /没有匹配到任何转发规则/);
  assert.match(html, /8\.8\.4\.4/);
  assert.match(html, /网络/);
  assert.match(html, /代理/);
  assert.match(html, /服务主机/);
});

test('直接访问面板未知路径返回 404（不渲染错误页）', async () => {
  const res = await fetch(base + '/no-such-page-xyz');
  assert.equal(res.status, 404);
});

test('config/fallback: 可修改兜底开关与状态码', async () => {
  const r = await call('PUT', '/api/config/fallback', { enabled: false, status: 404 });
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
  assert.equal(r.data.status, 404);
  // 关闭后兜底页应 404
  const res = await fetch(base + '/__fallback');
  assert.equal(res.status, 404);
  // 恢复
  await call('PUT', '/api/config/fallback', { enabled: true, status: 503 });
  const res2 = await fetch(base + '/__fallback');
  assert.equal(res2.status, 503);
});

// ---------- 日志路径设置 ----------
test('config/log-paths: 手动指定并恢复自动', async () => {
  const customAccess = path.join(tmp, 'custom-access.log');
  const customError = path.join(tmp, 'custom-error.log');
  const r = await call('PUT', '/api/config/log-paths', { access: customAccess, error: customError });
  assert.equal(r.status, 200);
  assert.equal(r.data.caddyAccessLog, customAccess);
  assert.equal(r.data.caddyErrorLog, customError);
  const g = await call('GET', '/api/config');
  assert.equal(g.data.accessLogSource, 'manual');
  assert.equal(g.data.errorLogSource, 'manual');
  // 相对路径拒绝
  const bad = await call('PUT', '/api/config/log-paths', { access: 'rel/path.log' });
  assert.equal(bad.status, 400);
  // 恢复自动
  const r2 = await call('PUT', '/api/config/log-paths', { access: '', error: '' });
  assert.equal(r2.status, 200);
  assert.notEqual(r2.data.accessLogSource, 'manual');
});

// ---------- 配置备份 / 自动回滚 ----------
test('apply 生效失败自动回滚到备份', async () => {
  const oldCfg = 'old-working-config\n';
  fs.writeFileSync(config.caddyfilePath, oldCfg, 'utf8');
  process.env.FAKE_FAIL = '1';
  try {
    const { status, data } = await call('POST', '/api/apply', {});
    assert.equal(status, 400);
    assert.equal(data.rolledBack, true);
    assert.ok(data.backupId);
    assert.ok(data.steps.includes('rollback'));
    // 线上配置已恢复为旧配置
    const now = fs.readFileSync(config.caddyfilePath, 'utf8');
    assert.equal(now, oldCfg);
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

test('backups: 列表与手动恢复', async () => {
  const g = await call('GET', '/api/backups');
  assert.equal(g.status, 200);
  assert.ok(Array.isArray(g.data.backups) && g.data.backups.length >= 1);
  const id = g.data.backups[0].id;
  const before = fs.readFileSync(config.caddyfilePath, 'utf8');
  fs.writeFileSync(config.caddyfilePath, 'should-be-reverted\n', 'utf8');
  const r = await call('POST', `/api/backups/${id}/restore`);
  assert.equal(r.status, 200);
  assert.equal(r.data.restored, true);
  const content = fs.readFileSync(config.caddyfilePath, 'utf8');
  assert.notEqual(content, 'should-be-reverted\n');
  assert.equal(content, before);
});

// ---------- 系统保护规则 ----------
test('protected 规则不可删除、不可停用', async () => {
  const r = await call('POST', '/api/rules', {
    name: '基础服务', domains: 'base.example.com', upstream: 'http://127.0.0.1:8888', protected: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.rule.protected, true);
  const del = await call('DELETE', `/api/rules/${r.data.rule.id}`);
  assert.equal(del.status, 400);
  assert.match(del.data.error, /保护/);
  const tog = await call('POST', `/api/rules/${r.data.rule.id}/toggle`);
  assert.equal(tog.status, 400);
  assert.match(tog.data.error, /保护/);
  // 非保护规则可正常删除
  const n = await call('POST', '/api/rules', { name: '普通', domains: 'normal.example.com', upstream: 'http://127.0.0.1:9001' });
  const nd = await call('DELETE', `/api/rules/${n.data.rule.id}`);
  assert.equal(nd.status, 200);
});

test('config/self-domain: 设置并返回面板自身域名', async () => {
  const r = await call('PUT', '/api/config/self-domain', { domain: 'panel.ykcode.top' });
  assert.equal(r.status, 200);
  assert.equal(r.data.selfDomain, 'panel.ykcode.top');
  const g = await call('GET', '/api/config');
  assert.equal(g.data.selfDomain, 'panel.ykcode.top');
  // 恢复空
  await call('PUT', '/api/config/self-domain', { domain: '' });
  const g2 = await call('GET', '/api/config');
  assert.equal(g2.data.selfDomain, '');
});

// ---------- 数据落盘可靠性 / 备份 ----------
test('settings 写盘自动生成备份', async () => {
  await call('PUT', '/api/config/fallback', { enabled: true, status: 503 });
  const files = fs.readdirSync(path.join(tmp, 'backups')).filter((f) => f.startsWith('settings-'));
  assert.ok(files.length >= 1, '应生成 settings 备份');
});

// ---------- 零信任网关错误页 ----------
test('零信任网关错误页 /__gateway-error 渲染三节点链路（状态/IP/日志ID/网关ID，不暴露后端地址）', async () => {
  const res = await fetch(base + '/__gateway-error?status=502&upstream=10.0.0.2:8080&host=api.example.com&path=/api/user&ip=8.8.4.4&log_id=log-test-123&gateway_id=caddymanager', {
    headers: { 'X-Forwarded-For': '9.9.9.9' },
  });
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /零信任网关/);
  assert.match(html, /你/);
  assert.match(html, /网关/);
  assert.match(html, /服务/);
  // 卡片只显示 你/网关/服务，不再展示 浏览器/零信任网关/后端服务器 名字行
  assert.doesNotMatch(html, />浏览器</);
  assert.doesNotMatch(html, />后端服务器</);
  // 查询参数优先于 header（X-Forwarded-For 9.9.9.9 应被 ip=8.8.4.4 覆盖）
  assert.match(html, /8\.8\.4\.4/);
  assert.doesNotMatch(html, /9\.9\.9\.9/);
  // 后端内网地址不得展示给终端用户
  assert.doesNotMatch(html, /10\.0\.0\.2:8080/);
  assert.doesNotMatch(html, /内网地址不公开/);
  // 日志 ID 展示 SHA-256 摘要前 12 位，不展示完整原始 ID
  const digest = createHash('sha256').update('log-test-123').digest('hex').slice(0, 12);
  assert.match(html, new RegExp(digest));
  assert.doesNotMatch(html, /log-test-123/);
  // 网关 ID 不展示在页面上（仅内部 header / 控制台对账）
  assert.doesNotMatch(html, /caddymanager/);
  assert.match(html, /api\.example\.com/);
  assert.match(html, /api\/user/);
});

test('零信任网关错误页：无查询参数时回退 header/IP 与日志 ID（网关 ID 不展示）', async () => {
  const res = await fetch(base + '/__gateway-error', {
    headers: { 'X-Forwarded-For': '8.8.4.4', 'X-Gateway-ID': 'gw-edge-1', 'X-Request-ID': 'log-abc' },
  });
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /8\.8\.4\.4/);
  assert.doesNotMatch(html, /gw-edge-1/);
  const digest = createHash('sha256').update('log-abc').digest('hex').slice(0, 12);
  assert.match(html, new RegExp(digest));
  assert.doesNotMatch(html, /log-abc/);
});

test('零信任网关错误页：无参数时正常渲染且不展示网关 ID', async () => {
  const res = await fetch(base + '/__gateway-error');
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /你/);
  assert.match(html, /网关/);
  assert.match(html, /服务/);
  assert.doesNotMatch(html, /caddymanager/);
});

test('/api/config 返回 gatewayId（默认 caddymanager）', async () => {
  const { status, data } = await call('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(data.gatewayId, 'caddymanager');
});
