import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('规则写盘自动备份（数据回收站，保留上限 10 份）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-store-bak-'));
  const store = new Store(path.join(tmp, 'rules.json'));
  for (let i = 0; i < 12; i++) {
    await store.create({ name: `r${i}`, domains: [`r${i}.com`], upstream: 'http://127.0.0.1:1' });
  }
  const files = fs.readdirSync(path.join(tmp, 'backups')).filter((f) => f.startsWith('rules-'));
  assert.ok(files.length >= 1, '应生成规则备份');
  assert.ok(files.length <= 10, '备份保留上限 10 份');
  // 最新规则真实落盘
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'rules.json'), 'utf8'));
  assert.equal(disk.length, 12);
});

test('update 可用空串/空数组清空解析元数据（lastError 不残留旧值）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-store-meta-'));
  const store = new Store(path.join(tmp, 'rules.json'));
  const { rule } = await store.create({ name: 'm', domains: ['m.com'], upstream: 'http://m.com:1' });

  await store.update(rule.id, { lastError: '旧的错误', resolvedIps: ['1.2.3.4'], lastCheckedAt: 't1', lastChangedAt: 't2' });
  let cur = store.get(rule.id);
  assert.equal(cur.lastError, '旧的错误');
  assert.deepEqual(cur.resolvedIps, ['1.2.3.4']);

  // 回归：显式传空串/空数组必须能清空（此前 has() 把空串当"缺省"过滤，导致 lastError 残留）
  await store.update(rule.id, { lastError: '', resolvedIps: [], lastCheckedAt: '', lastChangedAt: '' });
  cur = store.get(rule.id);
  assert.equal(cur.lastError, '');
  assert.deepEqual(cur.resolvedIps, []);
  // 真实落盘也保持一致
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'rules.json'), 'utf8'))[0];
  assert.equal(disk.lastError, '');
  assert.deepEqual(disk.resolvedIps, []);
});

test('数据目录只读时创建规则：明确报落盘失败并回滚内存', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-store-ro-'));
  const readonlyDir = path.join(tmp, 'ro');
  fs.mkdirSync(readonlyDir);
  fs.chmodSync(readonlyDir, 0o555); // 只读
  try {
    const store = new Store(path.join(readonlyDir, 'rules.json'));
    const r = await store.create({ name: 'x', domains: ['x.com'], upstream: 'http://127.0.0.1:1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /落盘失败/);
    assert.equal(store.list().length, 0, '落盘失败后内存已回滚');
  } finally {
    fs.chmodSync(readonlyDir, 0o755);
  }
});
