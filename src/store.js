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
      this.persist();
    } else {
      this.rules = [];
      this.persist();
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

  /** 合并写盘：同一时间窗内多次调用只落盘一次（写最新状态），异步返回。 */
  persist() {
    if (this._persistPromise) return this._persistPromise;
    this._persistPromise = new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.rules, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, this.file);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        this._persistPromise = null;
      }
    });
    return this._persistPromise;
  }

  list() {
    return this.rules.map((r) => ({ ...r }));
  }

  get(id) {
    const r = this.rules.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  create(input) {
    const { ok, value, error } = normalizeRule(input);
    if (!ok) return { ok: false, error };
    const now = nowIso();
    const rule = { ...value, id: randomId(), createdAt: now, updatedAt: now };
    const conflicts = findRuleConflicts(this.rules, rule);
    if (conflicts.length) return { ok: false, error: conflictMessage(conflicts), conflicts };
    this.rules.push(rule);
    this.persist();
    return { ok: true, rule: { ...rule } };
  }

  update(id, patch) {
    const idx = this.rules.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '规则不存在' };
    const { ok, value, error } = normalizeRule(patch, { partial: true });
    if (!ok) return { ok: false, error };
    const next = { ...this.rules[idx], ...value, updatedAt: nowIso() };
    const conflicts = findRuleConflicts(this.rules, next);
    if (conflicts.length) return { ok: false, error: conflictMessage(conflicts), conflicts };
    this.rules[idx] = next;
    this.persist();
    return { ok: true, rule: { ...this.rules[idx] } };
  }

  remove(id) {
    const idx = this.rules.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '规则不存在' };
    const [removed] = this.rules.splice(idx, 1);
    this.persist();
    return { ok: true, rule: removed };
  }

  toggle(id) {
    const idx = this.rules.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '规则不存在' };
    const nextEnabled = !this.rules[idx].enabled;
    if (nextEnabled) {
      const next = { ...this.rules[idx], enabled: true };
      const conflicts = findRuleConflicts(this.rules, next);
      if (conflicts.length) return { ok: false, error: conflictMessage(conflicts), conflicts };
    }
    this.rules[idx].enabled = nextEnabled;
    this.rules[idx].updatedAt = nowIso();
    this.persist();
    return { ok: true, rule: { ...this.rules[idx] } };
  }

  replaceAll(rules) {
    this.rules = this._withMeta(rules);
    this.persist();
    return this.list();
  }
}
