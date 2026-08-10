import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCaddyfile } from './generator.js';
import { backupCaddyfile, restoreBackup } from './backups.js';

/** 执行命令，返回 { code, stdout, stderr }（永不 reject，除非 spawn 本身失败）。 */
export function run(cmd, args = [], { timeoutMs = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------- 状态缓存（避免高频轮询反复 spawn 进程） ----------
const statusCache = { at: 0, ttl: 5000, version: null, running: false };

/** caddy 是否已安装（带 5s 缓存）。 */
export async function caddyInstalled(bin) {
  const now = Date.now();
  if (statusCache.at && now - statusCache.at < statusCache.ttl) {
    return statusCache.version;
  }
  const r = await run(bin, ['version']);
  statusCache.version = r.code === 0 ? r.stdout.trim() : null;
  statusCache.at = now;
  return statusCache.version;
}

/** caddy 是否正在运行：优先探测 admin API（localhost:2019），其次 pgrep。带缓存。 */
export async function caddyRunning(bin) {
  const now = Date.now();
  if (statusCache.at && now - statusCache.at < statusCache.ttl) {
    return statusCache.running;
  }
  let running = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch('http://localhost:2019/ping', { signal: ctrl.signal });
    clearTimeout(timer);
    running = res.ok;
  } catch { /* admin API 不可达 */ }
  if (!running) {
    const r = await run('pgrep', ['-x', path.basename(bin)]);
    running = r.code === 0;
  }
  statusCache.running = running;
  statusCache.at = now;
  return running;
}

/** 通过 Caddy admin API 热加载（最快生效路径，不 spawn 进程）。 */
export async function adminReload(content) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('http://localhost:2019/load', {
      method: 'POST',
      headers: { 'Content-Type': 'text/caddyfile' },
      body: content,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String((err && err.message) || err) };
  }
}

/** 探测正在运行的 Caddy 进程实际使用的配置文件（ps 查找 --config 参数）。 */
export async function detectRunningCaddyConfig() {
  const r = await run('ps', ['-axo', 'command=']);
  for (const line of (r.stdout || '').split('\n')) {
    if (!/caddy/i.test(line) || !/--config/.test(line)) continue;
    const m = line.match(/--config[=\s]+(\S+)/);
    if (m) return m[1];
  }
  return null;
}

function writeTemp(content) {
  const tmp = path.join(os.tmpdir(), `caddymanager-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(tmp, content, 'utf8');
  return tmp;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 应用配置（完整流水线）：
 *   1. 生成 Caddyfile
 *   2. caddy fmt 规范化（保证生成文件符合官方格式）
 *   3. caddy validate 校验（不合格绝不写盘）
 *   4. 原子写入目标路径
 *   5. 生效：
 *      a. 优先自定义 CADDY_RELOAD_CMD（shell 命令）
 *      b. 其次 Caddy admin API 热加载（POST /load，零进程开销）
 *      c. 再退化为 caddy reload CLI
 *      d. 若 caddy 未运行 → CADDY_START_CMD / caddy start
 *
 * options:
 *   dryRun     仅生成 + fmt + 校验，不写盘、不生效
 *   writeOnly  仅写盘，跳过 fmt/校验/生效（适用于 caddy 不在本机）
 */
export async function applyConfig({ config, rules, options = {} }) {
  let content = generateCaddyfile(rules, config);
  const result = {
    content,
    target: config.caddyfilePath,
    written: false,
    validated: false,
    reloaded: false,
    started: false,
    backupId: null,
    rolledBack: false,
    restoredReloaded: false,
    steps: [],
    errors: [],
    stdout: '',
    stderr: '',
  };

  if (options.writeOnly) {
    try {
      writeAtomic(config.caddyfilePath, content);
      result.written = true;
      result.steps.push('write');
    } catch (err) {
      result.errors.push(`写入失败: ${err.message}`);
    }
    return result;
  }

  // 1) fmt 规范化
  const tmp = writeTemp(content);
  const fmt = await run(config.caddyBin, ['fmt', '--overwrite', tmp]);
  result.steps.push('fmt');
  result.stdout += fmt.stdout;
  result.stderr += fmt.stderr;
  if (fmt.code === 0 && fs.existsSync(tmp)) {
    content = fs.readFileSync(tmp, 'utf8');
    result.content = content;
  }

  // 2) validate 校验
  const v = await run(config.caddyBin, ['validate', '--config', tmp, '--adapter', 'caddyfile']);
  result.steps.push('validate');
  result.stdout += v.stdout;
  result.stderr += v.stderr;
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (v.code !== 0) {
    result.errors.push('Caddyfile 校验未通过，已中止，未写入目标配置');
    return result;
  }
  result.validated = true;

  if (options.dryRun) return result;

  // 3) 写盘前自动备份（配置回收站：每次应用前保留一份线上配置）
  const backup = backupCaddyfile(config.caddyfilePath, config.dataDir);
  if (backup) {
    result.backupId = backup.id;
    result.steps.push(`backup(${backup.id})`);
  }

  // 4) 写盘（原子）
  try {
    writeAtomic(config.caddyfilePath, content);
    result.written = true;
    result.steps.push('write');
  } catch (err) {
    result.errors.push(`写入失败: ${err.message}（请检查目标路径权限，或调整 CADDYFILE_PATH）`);
    return result;
  }

  // 5) 生效（任一成功即完成；全部失败则自动回滚）
  let applied = false;
  let ar = { status: 0, body: '' };
  let reload = { code: -1, stdout: '', stderr: '' };

  if (config.caddyReloadCmd) {
    const r = await run('/bin/sh', ['-c', config.caddyReloadCmd]);
    result.steps.push('reload(custom shell)');
    result.stdout += r.stdout;
    result.stderr += r.stderr;
    if (r.code === 0) { result.reloaded = true; applied = true; }
    else result.errors.push(`自定义重载命令失败(code=${r.code}): ${r.stderr.trim()}`);
  }

  if (!applied) {
    // 快速路径：admin API 热加载
    ar = await adminReload(content);
    if (ar.ok) {
      result.reloaded = true;
      result.steps.push('reload(admin-api)');
      applied = true;
    }
  }

  if (!applied) {
    // CLI reload
    reload = await run(config.caddyBin, ['reload', '--config', config.caddyfilePath, '--adapter', 'caddyfile']);
    result.steps.push('reload(cli)');
    result.stdout += reload.stdout;
    result.stderr += reload.stderr;
    if (reload.code === 0) { result.reloaded = true; applied = true; }
  }

  if (!applied) {
    // 未运行 → 尝试启动
    if (config.caddyStartCmd) {
      const r = await run('/bin/sh', ['-c', config.caddyStartCmd]);
      result.steps.push('start(custom shell)');
      result.stdout += r.stdout;
      result.stderr += r.stderr;
      if (r.code === 0) { result.started = true; applied = true; }
      else result.errors.push(`自定义启动命令失败(code=${r.code}): ${r.stderr.trim()}`);
    } else {
      const start = await run(config.caddyBin, ['start', '--config', config.caddyfilePath, '--adapter', 'caddyfile']);
      result.steps.push('start(cli)');
      result.stdout += start.stdout;
      result.stderr += start.stderr;
      if (start.code === 0) { result.started = true; applied = true; }
      else {
        result.errors.push(
          `admin API 与 CLI reload/start 均失败。可能原因：caddy 未安装、admin API 被禁用或权限不足。` +
          `\nadmin API: ${ar.status} ${ar.body.trim()}` +
          `\nreload stderr: ${(reload.stderr || '').trim()}` +
          `\nstart stderr: ${(start.stderr || '').trim()}`
        );
      }
    }
  }

  // 6) 全部生效方式都失败 → 自动回滚到备份（防"瞎写挂全站"）
  if (!applied && result.backupId) {
    try {
      restoreBackup(config.dataDir, result.backupId, config.caddyfilePath);
      result.rolledBack = true;
      result.steps.push('rollback');
      result.errors.push('⚠ 新配置生效失败，已自动回滚到上一个可用配置');
      const oldContent = fs.readFileSync(config.caddyfilePath, 'utf8');
      const ar2 = await adminReload(oldContent);
      if (ar2.ok) {
        result.restoredReloaded = true;
        result.steps.push('rollback-reload(admin-api)');
      } else {
        const r2 = await run(config.caddyBin, ['reload', '--config', config.caddyfilePath, '--adapter', 'caddyfile']);
        if (r2.code === 0) {
          result.restoredReloaded = true;
          result.steps.push('rollback-reload(cli)');
        } else {
          result.errors.push(`回滚后重载旧配置也失败: ${(r2.stderr || '').trim()}`);
        }
      }
    } catch (err) {
      result.errors.push(`自动回滚失败: ${err.message}`);
    }
  }

  return result;
}

