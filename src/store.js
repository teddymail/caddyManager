import fs from 'node:fs';
import path from 'node:path';
import { randomId, nowIso, normalizeRule, exampleRules, findRuleConflicts, conflictMessage } from './util.js';

/**
 * 规则存储：单文件 JSON，写盘使用「临时文件 + rename」保证原子性。
 */
export class Store {
  constructor(file, { seedExamples = false } = {}) {
    this.file = file;
    this.rules = [];
    this._load(seedExamples);
  }

  _load(seedExamples) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      try {
        const data = JSON.parse(raw);
        this.rules = Array.isArray(data) ? data : data.rules || [];
      } catch (err) {
        throw new Error(`规则文件解析失败 (${this.file}): ${err.message}`);
      }
    } else if (seedExamples) {
      this.rules = this._withMeta(exampleRules());
      this.persist().catch(() => {}); // 初始化写盘失败不产生未处理异常，后续 CRUD 会明确报错
    } else {
      this.rules = [];
      this.persist().catch(() => {});
    }
  }

  _withMeta(rules) {
    const now = nowIso();
    return rules.map((r) => ({
      ...r,
      id: randomId(),
      createdAt: now,
      updatedAt: now,
    }));
  }

  /** 写盘（每次真实落盘，不做合并，避免被旧 promise 短路导致"看似成功实则丢失"）。写盘前自动备份旧版本。 */
  persist() {
    return new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        // 数据回收站：写盘前备份旧版本，防止覆盖/误删后无法恢复
        if (fs.existsSync(this.file)) {
          const backupDir = path.join(path.dirname(this.file), 'backups');
          fs.mkdirSync(backupDir, { recursive: true });
          const snap = path.join(backupDir, `rules-${Date.now()}.json`);
          fs.copyFileSync(this.file, snap);
          const snaps = fs.readdirSync(backupDir).filter((f) => f.startsWith('rules-')).sort();
          while (snaps.length > 10) fs.unlinkSync(path.join(backupDir, snaps.shift()));
        }
        const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(this.rules, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, this.file);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /** await persist 并捕获失败。 */
  async _persistSafe() {
    try {
      await this.persist();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  list() {
    return this.rules.map((r) => ({ ...r }));
  }

  get(id) {
    const r = this.rules.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  async create(input) {
    const { ok, value, error } = normalizeRule(input);
    if (!ok) return { ok: false, error };
    const now = nowIso();
    const rule = { ...value, id: randomId(), createdAt: now, updatedAt: now };
    const conflicts = findRuleConflicts(this.rules, rule);
    if (conflicts.length) return { ok: false, error: conflictMessage(conflicts), conflicts };
    this.rules.push(rule);
    const saved = await this._persistSafe();
    if (!saved.ok) {
      this.rules.pop(); // 落盘失败回滚内存，避免"看似成功实则丢失"
      return { ok: false, error: `数据落盘失败: ${saved.error}` };
    }
    return { ok: true, rule: { ...rule } };
  }

  async update(id, patch) {
    const idx = this.rules.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '规则不存在' };
    const { ok, value, error } = normalizeRule(patch, { partial: true });
    if (!ok) return { ok: false, error };
    const next = { ...this.rules[idx], ...value, updatedAt: nowIso() };
    const conflicts = findRuleConflicts(this.rules, next);
    if (conflicts.length) return { ok: false, error: conflictMessage(conflicts), conflicts };
    const prev = this.rules[idx];
    this.rules[idx] = next;
    const saved = await this._persistSafe();
    if (!saved.ok) {
      this.rules[idx] = prev; // 回滚
      return { ok: false, error: `数据落盘失败: ${saved.error}` };
    }
    return { ok: true, rule: { ...this.rules[idx] } };
  }

  async remove(id) {
    const idx = this.rules.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '规则不存在' };
    if (this.rules[idx].protected) return { ok: false, error: '该规则为系统保护规则（基础服务），不可删除' };
    const [removed] = this.rules.splice(idx, 1);
    const saved = await this._persistSafe();
    if (!saved.ok) {
      this.rules.splice(idx, 0, removed); // 回滚
      return { ok: false, error: `数据落盘失败: ${saved.error}` };
    }
    return { ok: true, rule: removed };
  }

  async toggle(id) {
    const idx = this.rules.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '规则不存在' };
    if (this.rules[idx].protected && this.rules[idx].enabled) {
      return { ok: false, error: '该规则为系统保护规则（基础服务），不可停用' };
    }
    const nextEnabled = !this.rules[idx].enabled;
    if (nextEnabled) {
      const next = { ...this.rules[idx], enabled: true };
      const conflicts = findRuleConflicts(this.rules, next);
      if (conflicts.length) return { ok: false, error: conflictMessage(conflicts), conflicts };
    }
    const prev = this.rules[idx];
    this.rules[idx] = { ...prev, enabled: nextEnabled, updatedAt: nowIso() };
    const saved = await this._persistSafe();
    if (!saved.ok) {
      this.rules[idx] = prev; // 回滚
      return { ok: false, error: `数据落盘失败: ${saved.error}` };
    }
    return { ok: true, rule: { ...this.rules[idx] } };
  }

  async replaceAll(rules) {
    const prev = this.rules;
    this.rules = this._withMeta(rules);
    const saved = await this._persistSafe();
    if (!saved.ok) {
      this.rules = prev;
      return { ok: false, error: `数据落盘失败: ${saved.error}` };
    }
    return { ok: true, rules: this.list() };
  }
}
