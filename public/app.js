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
      updateAuthBadge(false); // 同步登录状态，避免徽章与实际不一致
      if (!$('#token-modal').open) openTokenModal(true);
      throw new Error('令牌不正确或已失效，请重新输入');
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
      const protectBadge = r.protected
        ? '<span class="tag tag-protected" title="系统保护规则（基础服务），不可删除/停用">🔒 保护</span>' : '';
      const resolved = r.dnsMode === 'manager' && Array.isArray(r.resolvedIps) && r.resolvedIps.length
        ? `<div class="muted">已解析: ${r.resolvedIps.map(esc).join(', ')}</div>` : '';
      const dnsError = r.dnsMode === 'manager' && r.lastError
        ? `<div class="muted" style="color:var(--danger)" title="${esc(r.lastError)}">⚠ 看门狗: ${esc(r.lastError)}</div>` : '';
      const rowActions = r.protected
        ? '<span class="muted" style="font-size:12px">系统保护</span>'
        : `<div class="row-actions">
            <button class="btn" data-act="toggle" data-id="${r.id}">${r.enabled ? '停用' : '启用'}</button>
            <button class="btn" data-act="edit" data-id="${r.id}">编辑</button>
            <button class="btn" data-act="del" data-id="${r.id}" style="color:var(--danger)">删除</button>
          </div>`;
      tr.innerHTML = `
        <td><strong>${esc(r.name)}</strong>${protectBadge}${dnsBadge}</td>
        <td>${r.domains.map((d) => d.startsWith('*.')
          ? `<span class="tag tag-wild" title="通配符匹配：精确域名优先于本规则">🌐 ${esc(d)}</span>`
          : `<span class="tag">${esc(d)}</span>`).join('')}</td>
        <td><code>${esc(r.upstream)}</code>${resolved}${dnsError}${r.path ? `<div class="muted">路径: ${esc(r.path)}</div>` : ''}</td>
        <td><span class="${tlsClass}">${tlsLabel}</span></td>
        <td><span class="dot ${r.enabled ? 'dot-on' : 'dot-off'}"></span>${r.enabled ? '启用' : '停用'}</td>
        <td>${rowActions}</td>`;
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
    $('#f-fwdhdr').checked = rule ? rule.forwardHeaders !== false : true;
    $('#f-trustproxy').checked = rule ? Boolean(rule.trustProxy) : false;
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
    const body = {
      name: $('#f-name').value.trim(),
      domains: $('#f-domains').value,
      upstream: $('#f-upstream').value.trim(),
      tls: $('#f-tls').value,
      path: $('#f-path').value.trim(),
      healthPath: $('#f-health').value.trim(),
      stripPrefix: $('#f-strip').checked,
      forwardHeaders: $('#f-fwdhdr').checked,
      trustProxy: $('#f-trustproxy').checked,
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
  async function fetchAuthed(path) {
    const headers = {};
    const token = localStorage.getItem('cm_token') || '';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(path, { headers });
    if (res.status === 401) {
      updateAuthBadge(false);
      if (!$('#token-modal').open) openTokenModal(true);
      throw new Error('未登录或令牌无效，请先输入令牌');
    }
    return res;
  }
  async function showPreview() {
    try {
      const res = await fetchAuthed('/api/preview');
      const text = await res.text();
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
  let authed = false;
  function updateAuthBadge(ok) {
    authed = ok;
    const badge = $('#auth-badge');
    badge.textContent = ok ? '🔑 已登录' : '🔑 未登录';
    badge.className = `badge ${ok ? 'badge-ok' : 'badge-bad'}`;
    badge.title = ok ? '令牌已验证有效，操作自动携带' : '令牌无效或缺失，需要重新登录';
  }

  /** 真实校验 token：只有请求通过才算已登录（避免徽章与实际状态不一致）。 */
  async function verifyAuth() {
    const token = localStorage.getItem('cm_token');
    if (!token) { updateAuthBadge(false); return false; }
    try {
      const res = await fetch('/api/meta', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 200) { updateAuthBadge(true); return true; }
      if (res.status === 401) { updateAuthBadge(false); return false; }
      return authed; // 其他错误保持原状态
    } catch {
      return authed;
    }
  }

  function openTokenModal(force = false) {
    const has = !!localStorage.getItem('cm_token');
    if (!force && !has) { toast('当前服务未开启鉴权'); return; }
    $('#f-token').value = localStorage.getItem('cm_token') || '';
    const errEl = $('#token-error');
    if (errEl) errEl.classList.add('hidden');
    $('#token-status').textContent = has
      ? '✅ 令牌已保存在本浏览器，之后操作无需重复输入；如需更换请直接修改后保存。'
      : '服务已强制鉴权：请输入令牌（服务器启动日志可见，或由管理员设置 AUTH_TOKEN）。只需输入一次，浏览器会记住。';
    $('#token-modal').showModal();
  }

  async function saveToken() {
    const v = $('#f-token').value.trim();
    const errEl = $('#token-error');
    if (errEl) errEl.classList.add('hidden');
    if (!v) {
      localStorage.removeItem('cm_token');
      $('#token-modal').close();
      updateAuthBadge(false);
      toast('已清除 Token');
      return;
    }
    // 先向后端验证令牌，通过才保存
    try {
      const res = await fetch('/api/meta', { headers: { Authorization: `Bearer ${v}` } });
      if (res.status === 401) {
        errEl.textContent = '❌ 令牌不正确或已失效，请核对后重新输入';
        errEl.classList.remove('hidden');
        return; // 不关弹窗，让用户直接改
      }
      if (!res.ok) throw new Error(`验证失败 (HTTP ${res.status})`);
      localStorage.setItem('cm_token', v);
      $('#token-modal').close();
      updateAuthBadge(true);
      toast('Token 已保存，正在加载…');
      meta = await api('/api/meta');
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) { toast(err.message, 'err'); }
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
      const TOKEN_SOURCE = { env: '环境变量（Ansible/系统注入）', settings: '已持久化', generated: '自动生成' };
      const ts = $('#cfg-token-source');
      if (ts) {
        ts.textContent = TOKEN_SOURCE[c.authTokenSource] || c.authTokenSource || '-';
        ts.className = `tag ${c.authTokenSource === 'env' ? 'tag-tls-internal' : 'tag-dns'}`;
      }
      $('#f-cfgpath').value = c.source === 'manual' ? c.caddyfilePath : '';
      $('#f-fallback').checked = c.fallbackEnabled !== false;
      $('#f-fallback-status').value = c.fallbackStatus || 503;
      $('#f-log-access').value = c.accessLogSource === 'manual' ? c.caddyAccessLog : '';
      $('#f-log-error').value = c.errorLogSource === 'manual' ? c.caddyErrorLog : '';
      $('#f-selfdomain').value = c.selfDomain || '';
      loadBackups();
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

  async function loadBackups() {
    const wrap = $('#cfg-backups');
    if (!wrap) return;
    try {
      const b = await api('/api/backups');
      wrap.innerHTML = '';
      if (!b.backups || !b.backups.length) {
        wrap.innerHTML = '<span class="muted">暂无备份（应用配置后自动生成）</span>';
        return;
      }
      for (const bk of b.backups) {
        const row = document.createElement('div');
        row.className = 'cfg-cand';
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        const time = fmtTs ? fmtTs(bk.ts / 1000) : new Date(bk.ts).toLocaleString('zh-CN', { hour12: false });
        row.innerHTML = `<span>${esc(time)} · ${(bk.size / 1024).toFixed(1)}KB</span>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = '恢复';
        btn.addEventListener('click', async () => {
          if (!confirm('确认恢复该备份？将覆盖当前 Caddyfile 并重载')) return;
          try {
            const r = await api(`/api/backups/${bk.id}/restore`, { method: 'POST' });
            toast(r.reloaded ? '已恢复并重载 ✓' : (r.error || '已恢复，但重载失败'), r.reloaded ? 'ok' : 'err');
            await refreshStatus();
          } catch (e) { toast(e.message, 'err'); }
        });
        row.appendChild(btn);
        wrap.appendChild(row);
      }
    } catch (err) {
      wrap.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    }
  }

  async function saveCfgPath() {
    try {
      await api('/api/config/caddyfile-path', { method: 'PUT', body: { path: $('#f-cfgpath').value.trim() } });
      await api('/api/config/fallback', {
        method: 'PUT',
        body: { enabled: $('#f-fallback').checked, status: Number($('#f-fallback-status').value) || 503 },
      });
      await api('/api/config/log-paths', {
        method: 'PUT',
        body: { access: $('#f-log-access').value.trim(), error: $('#f-log-error').value.trim() },
      });
      await api('/api/config/self-domain', { method: 'PUT', body: { domain: $('#f-selfdomain').value.trim() } });
      $('#settings-modal').close();
      toast('已保存设置');
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- Caddy 日志查看 ----------
  let logsTimer = null;
  function fmtTs(ts) {
    if (!ts) return '';
    try { return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ts); }
  }
  async function loadLogs() {
    const type = $('#logs-type').value;
    const q = $('#logs-q').value.trim();
    const lines = $('#logs-lines').value;
    const c = await api(`/api/logs?type=${type}&lines=${lines}&q=${encodeURIComponent(q)}`);
    $('#logs-file').textContent = `日志文件: ${c.file}（显示 ${c.entries.length} 条）`;
    const wrap = $('#logs-list');
    wrap.innerHTML = '';
    if (!c.entries.length) {
      wrap.innerHTML = '<div class="empty"><p>暂无日志，请先「🚀 应用配置」让 Caddy 写入日志</p></div>';
      return;
    }
    for (const e of c.entries) {
      const row = document.createElement('div');
      row.className = 'log-row';
      if (e.parsed) {
        const p = e.parsed;
        if (type === 'error') {
          const lv = (p.level || 'info').toLowerCase();
          row.innerHTML = `<span class="log-ts">${fmtTs(p.ts)}</span> <span class="log-level lv-${lv}">${lv.toUpperCase()}</span> <span class="log-msg">${esc(p.msg || p.error || e.raw)}</span>`;
          if (lv === 'error' || lv === 'warn') row.classList.add('log-err');
        } else {
          const st = p.status;
          const cls = st >= 500 ? 'st-5xx' : st >= 400 ? 'st-4xx' : st >= 300 ? 'st-3xx' : 'st-2xx';
          const dur = p.duration ? `${(p.duration * 1000).toFixed(0)}ms` : '';
          const ip = p.request.remote_ip || '';
          const xff = (p.request.headers && p.request.headers['X-Forwarded-For']) || null;
          const size = p.size != null ? `${p.size}B` : '';
          row.innerHTML = `<span class="log-ts">${fmtTs(p.ts)}</span> <span class="log-status ${cls}">${st || '?'}</span> <span class="log-req">${esc(p.request.method || '')} ${esc(p.request.uri || '')}</span> <span class="log-ip" title="用户 IP${xff ? '，XFF: ' + esc(xff.join(', ')) : ''}">${esc(ip)}</span> <span class="log-host">${esc(p.request.host || '')}</span> <span class="log-size">${size}</span> <span class="log-dur">${dur}</span>`;
        }
      } else {
        row.innerHTML = `<span class="log-raw">${esc(e.raw)}</span>`;
      }
      wrap.appendChild(row);
    }
    wrap.scrollTop = wrap.scrollHeight;
  }
  function openLogs() {
    $('#logs-modal').showModal();
    loadLogs().catch((e) => toast(e.message, 'err'));
    clearInterval(logsTimer);
    logsTimer = setInterval(() => {
      if ($('#logs-auto').checked && $('#logs-modal').open) loadLogs().catch(() => {});
    }, 2000);
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

  // ---------- 零信任错误页预览 ----------
  async function openGatewayPreview() {
    try {
      const c = await api('/api/config');
      const q = new URLSearchParams({
        status: '500',
        upstream: '127.0.0.1:8080',
        host: 'api.example.com',
        path: '/api/v1/users',
        ip: '203.0.113.42',
        log_id: `preview-${Date.now().toString(36)}`,
        gateway_id: c.gatewayId || 'caddymanager',
      });
      window.open(`/__gateway-error?${q}`, '_blank');
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#btn-new').addEventListener('click', () => openRuleModal(null));
    $('#btn-examples').addEventListener('click', loadExamples);
    $('#btn-empty-examples').addEventListener('click', loadExamples);
    $('#btn-preview').addEventListener('click', showPreview);
    $('#btn-gw-preview').addEventListener('click', openGatewayPreview);
    $('#btn-validate').addEventListener('click', validateOnly);
    $('#btn-apply').addEventListener('click', applyNow);
    $('#btn-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#preview-content').textContent); toast('已复制'); }
      catch { toast('复制失败', 'err'); }
    });
    $('#btn-preview-validate').addEventListener('click', validateOnly);
    $('#btn-preview-apply').addEventListener('click', applyNow);
    $('#btn-refresh-dns').addEventListener('click', refreshDns);
    $('#btn-logs').addEventListener('click', openLogs);
    $('#btn-logs-refresh').addEventListener('click', () => loadLogs().catch((e) => toast(e.message, 'err')));
    $('#logs-type').addEventListener('change', () => loadLogs().catch((e) => toast(e.message, 'err')));
    $('#logs-lines').addEventListener('change', () => loadLogs().catch((e) => toast(e.message, 'err')));
    $('#logs-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLogs().catch((x) => toast(x.message, 'err')); });
    $('#logs-modal').addEventListener('close', () => clearInterval(logsTimer));
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-cfg-save').addEventListener('click', saveCfgPath);
    $('#btn-cfg-auto').addEventListener('click', () => { $('#f-cfgpath').value = ''; saveCfgPath(); });
    $('#f-dnsmode').addEventListener('change', toggleDnsFields);
    $('#btn-token').addEventListener('click', () => openTokenModal());
    $('#btn-token-save').addEventListener('click', saveToken);
    $('#btn-token-clear').addEventListener('click', async () => {
      localStorage.removeItem('cm_token');
      updateAuthBadge(false);
      $('#token-modal').close();
      toast('已退出登录');
      await new Promise((r) => setTimeout(r, 300));
      openTokenModal(true);
    });
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
    if (!localStorage.getItem('cm_token')) {
      updateAuthBadge(false);
      openTokenModal(true); // 服务默认强制鉴权，首次使用先输入令牌
      return;
    }
    const ok = await verifyAuth(); // 真实校验，避免"显示已登录但操作 401"
    if (!ok) {
      openTokenModal(true);
      return;
    }
    try { meta = await api('/api/meta'); } catch { /* ignore */ }
    try {
      await Promise.all([loadRules(), refreshStatus()]);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  init();
})();
