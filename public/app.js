/* Caddy Manager 前端逻辑（零依赖） */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  let meta = { defaultRule: {}, tlsModes: [] };

  // ---------- API 封装 ----------
  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    const token = localStorage.getItem('cm_token') || '';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 401) {
      openTokenModal(true);
      throw new Error('未授权，请先设置访问 Token');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg, type = 'ok') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  // ---------- 状态刷新 ----------
  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      $('#stat-total').textContent = s.rulesCount;
      $('#stat-path').textContent = s.config.caddyfilePath;
      const badge = $('#caddy-badge');
      if (s.caddy.installed) {
        badge.textContent = s.caddy.running ? 'Caddy 运行中 ✓' : 'Caddy 未运行';
        badge.className = `badge ${s.caddy.running ? 'badge-ok' : 'badge-bad'}`;
        badge.title = `版本: ${s.caddy.version}`;
      } else {
        badge.textContent = 'Caddy 未安装';
        badge.className = 'badge badge-bad';
      }
    } catch (e) { /* 401 已处理 */ }
  }

  // ---------- 规则列表 ----------
  async function loadRules() {
    const data = await api('/api/rules');
    const rules = data.rules;
    const tbody = $('#rules-tbody');
    tbody.innerHTML = '';
    $('#rule-count').textContent = `${rules.length} 条`;
    const enabled = rules.filter((r) => r.enabled).length;
    $('#stat-enabled').textContent = enabled;

    if (!rules.length) {
      $('#empty-state').classList.remove('hidden');
      $('#table-wrap').querySelector('.rules').classList.add('hidden');
      return;
    }
    $('#empty-state').classList.add('hidden');
    $('#table-wrap').querySelector('.rules').classList.remove('hidden');

    for (const r of rules) {
      const tr = document.createElement('tr');
      const tlsClass = `tag tag-tls-${r.tls}`;
      const tlsLabel = { auto: 'HTTPS 自动', internal: '内网自签', off: '仅 HTTP' }[r.tls] || r.tls;
      const dnsBadge = r.dnsMode && r.dnsMode !== 'off'
        ? `<span class="tag tag-dns" title="${r.dnsMode === 'caddy' ? 'Caddy dynamic a 自动跟随 IP' : '管理器看门狗自动更新 IP'}">🔄 ${r.dnsMode === 'caddy' ? '动态A' : '看门狗'}</span>` : '';
      const resolved = r.dnsMode === 'manager' && Array.isArray(r.resolvedIps) && r.resolvedIps.length
        ? `<div class="muted">已解析: ${r.resolvedIps.map(esc).join(', ')}</div>` : '';
      tr.innerHTML = `
        <td><strong>${esc(r.name)}</strong>${dnsBadge}</td>
        <td>${r.domains.map((d) => `<span class="tag">${esc(d)}</span>`).join('')}</td>
        <td><code>${esc(r.upstream)}</code>${resolved}${r.path ? `<div class="muted">路径: ${esc(r.path)}</div>` : ''}</td>
        <td><span class="${tlsClass}">${tlsLabel}</span></td>
        <td><span class="dot ${r.enabled ? 'dot-on' : 'dot-off'}"></span>${r.enabled ? '启用' : '停用'}</td>
        <td>
          <div class="row-actions">
            <button class="btn" data-act="toggle" data-id="${r.id}">${r.enabled ? '停用' : '启用'}</button>
            <button class="btn" data-act="edit" data-id="${r.id}">编辑</button>
            <button class="btn" data-act="del" data-id="${r.id}" style="color:var(--danger)">删除</button>
          </div>
        </td>`;
      tbody.appendChild(tr);
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 规则表单 ----------
  function openRuleModal(rule) {
    $('#modal-title').textContent = rule ? '编辑规则' : '新增规则';
    $('#f-id').value = rule ? rule.id : '';
    $('#f-name').value = rule ? rule.name : (meta.defaultRule.name || '');
    $('#f-domains').value = rule ? rule.domains.join(', ') : '';
    $('#f-upstream').value = rule ? rule.upstream : (meta.defaultRule.upstream || '');
    $('#f-tls').value = rule ? rule.tls : 'auto';
    $('#f-path').value = rule ? (rule.path || '') : '';
    $('#f-health').value = rule ? (rule.healthPath || '') : '';
    $('#f-strip').checked = rule ? Boolean(rule.stripPrefix) : false;
    $('#f-enabled').checked = rule ? rule.enabled !== false : true;
    $('#f-extra').value = rule ? (rule.extra || '') : '';
    $('#f-dnsmode').value = rule ? (rule.dnsMode || 'off') : 'off';
    $('#f-dnshost').value = rule ? (rule.dnsHost || '') : '';
    const interval = rule ? (rule.dnsMode === 'manager' ? rule.dnsInterval : rule.lookupInterval) : 60;
    $('#f-dnsinterval').value = interval || 60;
    $('#f-dnsresolvers').value = rule ? (rule.dnsResolvers || '') : '';
    toggleDnsFields();
    $('#rule-modal').showModal();
  }

  function toggleDnsFields() {
    const mode = $('#f-dnsmode').value;
    $('#dns-fields').classList.toggle('hidden', mode === 'off');
    $('#lbl-dnsinterval').textContent = mode === 'manager' ? '探测间隔（秒）' : 'Caddy 刷新间隔（秒）';
  }

  function readForm() {
    return {
      name: $('#f-name').value.trim(),
      domains: $('#f-domains').value,
      upstream: $('#f-upstream').value.trim(),
      tls: $('#f-tls').value,
      path: $('#f-path').value.trim(),
      healthPath: $('#f-health').value.trim(),
      stripPrefix: $('#f-strip').checked,
      enabled: $('#f-enabled').checked,
      extra: $('#f-extra').value,
      dnsMode: $('#f-dnsmode').value,
      dnsHost: $('#f-dnshost').value.trim(),
      dnsResolvers: $('#f-dnsresolvers').value.trim(),
    };
    const mode = body.dnsMode;
    const interval = Number($('#f-dnsinterval').value) || 60;
    if (mode === 'caddy') body.lookupInterval = interval;
    if (mode === 'manager') body.dnsInterval = interval;
    return body;
  }

  async function saveRule(e) {
    e.preventDefault();
    const id = $('#f-id').value;
    const body = readForm();
    try {
      if (id) await api(`/api/rules/${id}`, { method: 'PUT', body });
      else await api('/api/rules', { method: 'POST', body });
      $('#rule-modal').close();
      toast('已保存');
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function deleteRule(id) {
    if (!confirm('确定删除该规则？')) return;
    try {
      await api(`/api/rules/${id}`, { method: 'DELETE' });
      toast('已删除');
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function toggleRule(id) {
    try {
      await api(`/api/rules/${id}/toggle`, { method: 'POST' });
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- 预览 / 校验 / 应用 ----------
  async function showPreview() {
    try {
      const text = await (await fetch('/api/preview')).text();
      $('#preview-content').textContent = text;
      $('#preview-modal').showModal();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function validateOnly() {
    try {
      const r = await api('/api/apply', { method: 'POST', body: { dryRun: true } });
      if (r.ok) toast('校验通过 ✓ 配置合法');
      else toast(`校验失败: ${r.error}`, 'err');
      showResult(r);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function applyNow() {
    if (!confirm('将生成 Caddyfile 并替换目标配置，然后重载 Caddy，确定继续？')) return;
    try {
      const r = await api('/api/apply', { method: 'POST', body: {} });
      if (r.ok) toast('配置已应用 ✓');
      else toast(`应用失败: ${r.error}`, 'err');
      showResult(r);
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  }

  function showResult(r) {
    $('#result-title').textContent = r.ok ? '执行成功' : '执行失败';
    const lines = [];
    lines.push(`目标路径: ${r.target}`);
    lines.push(`步骤: ${(r.steps || []).join(' → ') || '无'}`);
    lines.push(`校验: ${r.validated ? '通过' : (r.dryRun ? '未执行' : '失败')}`);
    if (r.written) lines.push(`写盘: 已写入 ${r.target}`);
    if (r.reloaded) lines.push('重载: Caddy 已重载');
    if (r.started) lines.push('启动: Caddy 已启动');
    if (r.error) { lines.push(''); lines.push(`错误: ${r.error}`); }
    if (r.stderr && r.stderr.trim()) { lines.push(''); lines.push('--- 输出 ---'); lines.push(r.stderr.trim()); }
    if (!r.ok && r.content) { lines.push(''); lines.push('--- 生成的配置 ---'); lines.push(r.content); }
    $('#result-content').textContent = lines.join('\n');
    $('#result-modal').showModal();
  }

  // ---------- Token ----------
  function openTokenModal(force = false) {
    const has = !!localStorage.getItem('cm_token');
    if (!force && !has) { toast('当前服务未开启鉴权'); return; }
    $('#f-token').value = localStorage.getItem('cm_token') || '';
    $('#token-modal').showModal();
  }

  function saveToken() {
    const v = $('#f-token').value.trim();
    if (v) localStorage.setItem('cm_token', v);
    else localStorage.removeItem('cm_token');
    $('#token-modal').close();
    toast(v ? 'Token 已保存' : '已清除 Token');
  }

  // ---------- Caddyfile 路径设置 ----------
  const SOURCE_LABEL = {
    env: '由环境变量指定',
    manual: '手动指定',
    auto: '自动定位',
    default: '默认路径',
    'running-caddy': '运行中的 Caddy',
  };
  async function openSettings() {
    try {
      const c = await api('/api/config');
      $('#cfg-path').textContent = c.caddyfilePath;
      const src = $('#cfg-source');
      src.textContent = SOURCE_LABEL[c.source] || c.source;
      src.className = `tag ${c.source === 'manual' || c.source === 'env' ? 'tag-tls-internal' : 'tag-dns'}`;
      $('#f-cfgpath').value = c.source === 'manual' ? c.caddyfilePath : '';
      const wrap = $('#cfg-candidates');
      wrap.innerHTML = '';
      for (const cand of c.candidates) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost cfg-cand';
        if (cand.active) b.classList.add('cfg-cand-active');
        b.textContent = `${cand.path}（${SOURCE_LABEL[cand.source] || cand.source}）`;
        b.title = '点击设为当前目标路径';
        b.addEventListener('click', async () => {
          await api('/api/config/caddyfile-path', { method: 'PUT', body: { path: cand.path } });
          toast('已选择，应用配置将写入该路径');
          await openSettings();
          await refreshStatus();
        });
        wrap.appendChild(b);
      }
      $('#settings-modal').showModal();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function saveCfgPath() {
    try {
      await api('/api/config/caddyfile-path', { method: 'PUT', body: { path: $('#f-cfgpath').value.trim() } });
      $('#settings-modal').close();
      toast('已保存目标路径');
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- 刷新 DNS ----------
  async function refreshDns() {
    try {
      const r = await api('/api/refresh-dns', { method: 'POST' });
      const n = r.changed ? r.changed.length : 0;
      toast(n ? `✅ ${n} 条动态域名 IP 已变化，已自动更新并热重载` : 'DNS 检查完成，IP 无变化');
      if (r.errors && r.errors.length) toast(`部分解析失败: ${r.errors.map((e) => e.error).join('; ')}`, 'err');
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) { toast(err.message, 'err'); }
  }


  // ---------- 示例 ----------
  async function loadExamples() {
    if (!confirm('将覆盖当前所有规则并载入示例规则，确定？')) return;
    try {
      await api('/api/examples', { method: 'POST' });
      toast('示例规则已载入');
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#btn-new').addEventListener('click', () => openRuleModal(null));
    $('#btn-examples').addEventListener('click', loadExamples);
    $('#btn-empty-examples').addEventListener('click', loadExamples);
    $('#btn-preview').addEventListener('click', showPreview);
    $('#btn-validate').addEventListener('click', validateOnly);
    $('#btn-apply').addEventListener('click', applyNow);
    $('#btn-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#preview-content').textContent); toast('已复制'); }
      catch { toast('复制失败', 'err'); }
    });
    $('#btn-preview-validate').addEventListener('click', validateOnly);
    $('#btn-preview-apply').addEventListener('click', applyNow);
    $('#btn-refresh-dns').addEventListener('click', refreshDns);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-cfg-save').addEventListener('click', saveCfgPath);
    $('#btn-cfg-auto').addEventListener('click', () => { $('#f-cfgpath').value = ''; saveCfgPath(); });
    $('#f-dnsmode').addEventListener('change', toggleDnsFields);
    $('#btn-token').addEventListener('click', () => openTokenModal());
    $('#btn-token-save').addEventListener('click', saveToken);
    $('#rule-form').addEventListener('submit', saveRule);

    $$('[data-close]').forEach((b) => b.addEventListener('click', () => $(`#${b.dataset.close}`).close()));

    $('#rules-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const { act, id } = btn.dataset;
      if (act === 'edit') {
        api(`/api/rules/${id}`).then((d) => openRuleModal(d.rule)).catch((err) => toast(err.message, 'err'));
      } else if (act === 'del') deleteRule(id);
      else if (act === 'toggle') toggleRule(id);
    });

    $('#preview-modal').addEventListener('close', () => { /* noop */ });
  }

  // ---------- 启动 ----------
  async function init() {
    bind();
    try { meta = await api('/api/meta'); } catch { /* ignore */ }
    try {
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  init();
})();
