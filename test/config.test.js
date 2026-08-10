import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-config-test-'));

test('authToken 优先级：Ansible/环境变量注入 > 持久化 > 自动生成', () => {
  // 1) Ansible 注入 AUTH_TOKEN -> 用注入的，不自动生成
  const c1 = loadConfig({ AUTH_TOKEN: 'ansible-injected-token', DATA_DIR: tmp });
  assert.equal(c1.authToken, 'ansible-injected-token');
  assert.equal(c1.authTokenSource, 'env');

  // 2) 未注入且无持久化 -> 自动生成（且不覆盖注入场景）
  const c2 = loadConfig({ DATA_DIR: tmp });
  assert.equal(c2.authTokenSource, 'generated');
  assert.ok(c2.authToken.length >= 32);

  // 3) 再次加载 -> 使用已持久化的 token（只有没设置时才自动生成，生成一次）
  const c3 = loadConfig({ DATA_DIR: tmp });
  assert.equal(c3.authToken, c2.authToken);
  assert.equal(c3.authTokenSource, 'settings');

  // 4) 即使 settings 已有 token，Ansible 注入依然优先
  const c4 = loadConfig({ AUTH_TOKEN: 'ansible-token-2', DATA_DIR: tmp });
  assert.equal(c4.authToken, 'ansible-token-2');
  assert.equal(c4.authTokenSource, 'env');
});
