import fs from 'node:fs';
import path from 'node:path';

const MAX_BACKUPS = 10;

export function backupDirFor(dataDir) {
  return path.join(dataDir, 'backups');
}

function manifestFile(dataDir) {
  return path.join(backupDirFor(dataDir), 'manifest.json');
}

function readManifest(dataDir) {
  try {
    const list = JSON.parse(fs.readFileSync(manifestFile(dataDir), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeManifest(dataDir, list) {
  fs.mkdirSync(backupDirFor(dataDir), { recursive: true });
  fs.writeFileSync(manifestFile(dataDir), JSON.stringify(list, null, 2) + '\n', 'utf8');
}

/** 备份当前线上 Caddyfile，返回备份记录；线上文件不存在则返回 null。 */
export function backupCaddyfile(caddyfilePath, dataDir) {
  if (!caddyfilePath || !fs.existsSync(caddyfilePath)) return null;
  let content;
  try {
    content = fs.readFileSync(caddyfilePath, 'utf8');
  } catch {
    return null;
  }
  const ts = Date.now();
  const id = `bak-${ts}`;
  const file = path.join(backupDirFor(dataDir), `${id}.conf`);
  fs.mkdirSync(backupDirFor(dataDir), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  const record = { id, file, ts, size: content.length, source: caddyfilePath };
  const list = [record, ...readManifest(dataDir)].slice(0, MAX_BACKUPS);
  writeManifest(dataDir, list);
  return record;
}

/** 列出备份（新到旧）。 */
export function listBackups(dataDir) {
  return readManifest(dataDir);
}

/** 恢复指定备份到目标路径（原子写回），返回备份内容。 */
export function restoreBackup(dataDir, id, caddyfilePath) {
  const rec = readManifest(dataDir).find((b) => b.id === id);
  if (!rec) throw new Error('备份不存在');
  if (!fs.existsSync(rec.file)) throw new Error('备份文件缺失');
  const content = fs.readFileSync(rec.file, 'utf8');
  fs.mkdirSync(path.dirname(caddyfilePath), { recursive: true });
  const tmp = `${caddyfilePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, caddyfilePath);
  return content;
}
