import { run } from './caddy.js';

/** 解析 Caddy JSON 日志行；失败则返回仅含原始行的对象。 */
export function parseCaddyLogLine(raw) {
  try {
    const d = JSON.parse(raw);
    const req = d.request || {};
    return {
      parsed: true,
      ts: d.ts,
      level: d.level,
      msg: d.msg,
      status: d.status,
      duration: d.duration,
      size: d.size,
      error: d.error,
      request: {
        method: req.method,
        uri: req.uri,
        host: req.host,
        remote_ip: req.remote_ip,
        user_agent: req.user_agent,
      },
      raw,
    };
  } catch {
    return { parsed: false, raw };
  }
}

/** 读取日志文件尾部 N 行（用系统 tail，避免大文件全量读入内存）。 */
export async function readLogTail(file, maxLines) {
  const r = await run('tail', ['-n', String(maxLines), file]);
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || '日志文件读取失败', lines: [] };
  }
  const lines = (r.stdout || '').split('\n').filter((l) => l.trim());
  return { ok: true, lines };
}
