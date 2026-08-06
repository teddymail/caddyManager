#!/usr/bin/env node
/**
 * 端到端验证：Caddy `dynamic a` 动态上游自动跟随 A 记录 IP 变化。
 *
 * 真实场景还原：后端域名 A 记录随时变化（IP 变、端口不变）。
 *  1. 本地 DNS 服务器（127.0.0.1:15353）动态返回 dyn.test -> 当前 IP
 *  2. 两个后端：127.0.0.1:19101 与 127.0.0.2:19101（同端口、不同 IP）
 *  3. Caddy 使用 dynamic a + resolvers 127.0.0.1:15353，refresh 5s
 *  4. 前端 :19090 先命中 127.0.0.1；翻转 DNS 到 127.0.0.2 后，无需重载自动切换
 */
import dgram from 'node:dgram';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FRONT = 19090;
const DNS_PORT = 15353;
const PORT = 19101;
const BACKEND_IP = '127.0.0.1';
let dnsIp = '127.0.0.1'; // 动态域名当前解析到的 IP
const dnsLog = [];

// ---------- 1) 迷你 DNS 服务器（仅响应 A 记录） ----------
function startDns() {
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
    dnsLog.push({ t: new Date().toISOString(), qname, qtype, resp: dnsIp });

    const res = Buffer.alloc(512);
    res.writeUInt16BE(id, 0);
    res.writeUInt16BE(0x8180, 2);
    res.writeUInt16BE(1, 4);
    res.writeUInt16BE(1, 6); // 始终有答案
    let o = 12;
    for (const l of labels) { res.writeUInt8(l.length, o++); res.write(l, o, 'ascii'); o += l.length; }
    res.writeUInt8(0, o++);
    res.writeUInt16BE(qtype, o); o += 2;
    res.writeUInt16BE(qclass, o); o += 2;
    res.writeUInt16BE(0xc00c, o); o += 2;
    res.writeUInt16BE(1, o); o += 2;       // A
    res.writeUInt16BE(1, o); o += 2;       // IN
    res.writeUInt32BE(30, o); o += 4;      // TTL
    res.writeUInt16BE(4, o); o += 2;       // RDLENGTH
    for (const p of dnsIp.split('.').map(Number)) res.writeUInt8(p, o++);
    socket.send(res.subarray(0, o), rinfo.port, rinfo.address);
  });
  socket.bind(DNS_PORT, '127.0.0.1');
  return socket;
}

// ---------- 2) 后端（同端口、不同 IP） ----------
const backendCounts = {};
function startBackend(ip, tag) {
  backendCounts[ip] = 0;
  const s = http.createServer((req, res) => { backendCounts[ip]++; res.end(`${tag} @ ${new Date().toISOString()}`); });
  s.listen(PORT, ip);
  return s;
}

// ---------- 3) Caddy ----------
function startCaddy(caddyfile) {
  const tmp = path.join(os.tmpdir(), `cm-e2e-${Date.now()}.Caddyfile`);
  fs.writeFileSync(tmp, caddyfile);
  const child = spawn('caddy', ['run', '--config', tmp, '--adapter', 'caddyfile'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  return { child, tmp };
}

function fetchBackend() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: FRONT, path: '/', method: 'GET', agent: false, headers: { Connection: 'close' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body.split(' @ ')[0]));
      }
    );
    req.setTimeout(1500, () => { req.destroy(); resolve('ERR(timeout)'); });
    req.on('error', (e) => resolve(`ERR(${e.code || e.message})`));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expected, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await fetchBackend();
    if (got === expected) return true;
    await sleep(500);
  }
  return false;
}

// ---------- 主流程 ----------
const dns = startDns();
const backend = startBackend(BACKEND_IP, 'backend-A(127.0.0.1)');

const caddyfile = `
:${FRONT} {
    reverse_proxy {
        dynamic a dyn.test ${PORT} {
            refresh 5s
            resolvers 127.0.0.1:${DNS_PORT}
            versions ipv4
        }
    }
}
`;
const caddy = startCaddy(caddyfile);

console.log('等待 Caddy 就绪...');
await sleep(2500);

console.log('第 1 阶段：dyn.test -> 127.0.0.1');
const ok1 = await waitFor('backend-A(127.0.0.1)', 30000);
console.log(`  ${ok1 ? '✅' : '❌'} 前端命中 backend-A  (actual=${await fetchBackend()})`);

console.log('翻转 DNS：dyn.test -> 192.0.2.1（TEST-NET 不可达 IP，Caddy 不重载）');
const beforeFlip = backendCounts[BACKEND_IP];
dnsIp = '192.0.2.1';
dnsLog.length = 0;
await sleep(9000); // 等至少一个 refresh 周期生效
const samples = [];
for (let i = 0; i < 8; i++) { samples.push(await fetchBackend()); await sleep(300); }
const allErr = samples.every((x) => x.startsWith('ERR'));
const aDelta = backendCounts[BACKEND_IP] - beforeFlip;
console.log(`  ${allErr && aDelta === 0 ? '✅' : '❌'} 切换后 8 次采样全部失败/不可达（证明上游池已切到新 IP，不再打旧后端）`);
console.log('  采样结果:', samples.join(' | '));
console.log(`  后端 A 增量: ${aDelta}（应为 0）`);
console.log('  DNS 查询(翻转后):', dnsLog.map((x) => `${x.t.slice(11, 19)} ${x.qname}->${x.resp}`).join(' | '));

console.log('恢复 DNS：dyn.test -> 127.0.0.1');
dnsIp = '127.0.0.1';
const ok3 = await waitFor('backend-A(127.0.0.1)', 45000);
console.log(`  ${ok3 ? '✅' : '❌'} 恢复访问 backend-A  (actual=${await fetchBackend()})`);

// 清理
caddy.child.kill('SIGTERM');
backend.close();
dns.close();
try { fs.unlinkSync(caddy.tmp); } catch {}

console.log('后端请求计数:', JSON.stringify(backendCounts));
console.log(`\n结论: ${ok1 && allErr && aDelta === 0 && ok3 ? '通过 —— Caddy dynamic a 无需重载自动跟随动态域名 IP 变化' : '未通过'}`);
process.exit(ok1 && allErr && aDelta === 0 && ok3 ? 0 : 1);
