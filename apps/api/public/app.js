/* global crypto */
(function () {
  'use strict';

  const STORAGE_KEY = 'infomemory.workbench.session.v1';
  const state = {
    connected: false,
    authMode: 'trusted_headers',
    tenantId: '',
    userId: '',
    token: '',
    remember: false,
    assetCursor: null,
    assetRows: [],
    feishuOAuthEnabled: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    setup: $('setup-panel'),
    workspace: $('workspace'),
    identityForm: $('identity-form'),
    tenant: $('tenant-id'),
    user: $('user-id'),
    authMode: $('auth-mode'),
    tokenField: $('token-field'),
    token: $('access-token'),
    remember: $('remember-session'),
    authHelp: $('auth-help'),
    authBadge: $('auth-mode-badge'),
    connection: $('connection-pill'),
    workspaceLabel: $('workspace-label'),
    workspaceUser: $('workspace-user'),
    serviceStatus: $('service-status'),
    serviceVersion: $('service-version'),
    feishuStatus: $('feishu-status'),
    feishuDetail: $('feishu-detail'),
    assetForm: $('asset-form'),
    assetTitle: $('asset-title'),
    assetContent: $('asset-content'),
    assetVisibility: $('asset-visibility'),
    assetSourceType: $('asset-source-type'),
    assetSourceUrl: $('asset-source-url'),
    assetIdempotency: $('asset-idempotency'),
    assetWriteResult: $('asset-write-result'),
    assetList: $('asset-list'),
    assetFilterVisibility: $('asset-filter-visibility'),
    assetPageNote: $('asset-page-note'),
    loadMoreAssets: $('load-more-assets'),
    assetDetail: $('asset-detail'),
    searchForm: $('search-form'),
    searchQuery: $('search-query'),
    searchLimit: $('search-limit'),
    searchResult: $('search-result'),
    answerForm: $('answer-form'),
    answerQuery: $('answer-query'),
    answerResult: $('answer-result'),
    evidenceList: $('evidence-list'),
    reminderForm: $('reminder-form'),
    reminderTitle: $('reminder-title'),
    reminderStarts: $('reminder-starts'),
    reminderAt: $('reminder-at'),
    reminderWriteResult: $('reminder-write-result'),
    reminderList: $('reminder-list'),
    reminderFilterStatus: $('reminder-filter-status'),
    connectorStatus: $('connector-status'),
    installation: $('feishu-installation'),
    startOAuth: $('start-feishu-oauth'),
    refreshOAuth: $('refresh-feishu'),
    revokeOAuth: $('revoke-feishu'),
    callbackUrl: $('feishu-callback-url'),
    toastRegion: $('toast-region'),
  };

  const STATUS_LABELS = {
    scheduled: '已安排',
    needs_confirmation: '待确认',
    completed: '已完成',
    cancelled: '已取消',
  };

  function text(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = text(content);
    return element;
  }

  function child(parent, value) {
    if (value) parent.append(value);
    return value;
  }

  function setVisible(element, visible) {
    element.classList.toggle('is-hidden', !visible);
  }

  function setResult(element, message, kind) {
    element.className = 'result-box' + (kind ? ' ' + kind : '');
    element.textContent = text(message);
    setVisible(element, true);
  }

  function clearResult(element) {
    element.textContent = '';
    element.className = 'result-box is-hidden';
  }

  function toast(message, kind) {
    const item = node('div', 'toast' + (kind === 'error' ? ' error' : ''), message);
    els.toastRegion.append(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  function setBusy(form, busy) {
    form.querySelectorAll('button, input, textarea, select').forEach((element) => {
      element.disabled = busy;
    });
  }

  function randomKey(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return prefix + '-' + window.crypto.randomUUID();
    }
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function readSavedSession() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function persistSession() {
    try {
      if (!state.remember) {
        window.localStorage.removeItem(STORAGE_KEY);
        return;
      }
      // Persist only non-sensitive identity hints. Bearer tokens are never
      // written to localStorage/sessionStorage, the URL, analytics, or logs.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        authMode: state.authMode,
        tenantId: state.tenantId,
        userId: state.userId,
      }));
    } catch {
      // Storage may be disabled by a browser policy; the in-memory session is
      // still fully usable.
    }
  }

  function clearSession() {
    state.connected = false;
    state.tenantId = '';
    state.userId = '';
    state.token = '';
    state.remember = false;
    state.assetCursor = null;
    state.assetRows = [];
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    els.tenant.value = '';
    els.user.value = '';
    els.token.value = '';
    els.remember.checked = false;
    setVisible(els.workspace, false);
    setVisible(els.setup, true);
    setConnection('idle', '未连接');
    toast('会话已清除；令牌已从页面内存移除。');
  }

  function setConnection(kind, label) {
    els.connection.className = 'status-pill status-' + kind;
    els.connection.textContent = label;
  }

  function syncAuthMode() {
    const bearer = els.authMode.value === 'bearer';
    els.tokenField.classList.toggle('is-hidden', !bearer);
    els.token.required = bearer;
    els.tenant.required = !bearer;
    els.user.required = !bearer;
    els.authBadge.textContent = bearer ? 'bearer token' : 'trusted headers';
    els.authHelp.textContent = bearer
      ? '生产模式只使用 Authorization: Bearer；令牌中的租户与用户声明由服务端校验。不要把令牌粘贴到截图或聊天记录。'
      : '开发模式会发送 x-tenant-id 与 x-user-id 请求头；该模式只允许在 development/test 环境使用。';
  }

  function loadSavedSession() {
    const saved = readSavedSession();
    if (!saved) return;
    if (saved.authMode === 'trusted_headers' || saved.authMode === 'bearer') {
      els.authMode.value = saved.authMode;
    }
    if (typeof saved.tenantId === 'string' && saved.tenantId.length <= 200) els.tenant.value = saved.tenantId;
    if (typeof saved.userId === 'string' && saved.userId.length <= 200) els.user.value = saved.userId;
    els.remember.checked = true;
    // Migrate sessions created by older workbench builds that persisted a
    // token. Only the non-sensitive identity hints survive this rewrite.
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        authMode: els.authMode.value,
        tenantId: els.tenant.value,
        userId: els.user.value,
      }));
    } catch { /* noop */ }
    syncAuthMode();
  }

  function authHeaders(json) {
    const headers = { accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';
    if (state.authMode === 'bearer') {
      if (state.token) headers.authorization = 'Bearer ' + state.token;
    } else {
      headers['x-tenant-id'] = state.tenantId;
      headers['x-user-id'] = state.userId;
    }
    return headers;
  }

  async function request(path, options) {
    const config = options || {};
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    const headers = Object.assign(authHeaders(Boolean(config.body)), config.headers || {});
    try {
      const response = await fetch(path, {
        method: config.method || 'GET',
        headers,
        body: config.body,
        signal: controller.signal,
        credentials: 'same-origin',
      });
      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      if (!response.ok) {
        const message = data && typeof data.message === 'string'
          ? data.message
          : '请求失败（HTTP ' + response.status + '）';
        const error = new Error(message);
        error.status = response.status;
        error.code = data && typeof data.error === 'string' ? data.error : 'request_failed';
        throw error;
      }
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('请求超时，请检查服务状态后重试');
      if (error instanceof TypeError) throw new Error('无法连接服务，请确认 API 正在运行');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function jsonBody(value) {
    return JSON.stringify(value);
  }

  function syncFeishuOAuthAvailability() {
    setVisible(els.startOAuth, state.feishuOAuthEnabled !== false);
  }

  async function loadHealth() {
    const health = await request('/health');
    const healthy = health && health.status === 'ok';
    els.serviceStatus.textContent = healthy ? '运行正常' : '需要检查';
    els.serviceVersion.textContent = health && health.version ? '版本 ' + health.version : '详情受保护';
    const feishuConfigured = health && health.feishuConfigured;
    const notifications = health && health.feishuNotificationsEnabled;
    const connectorCapabilities = health && health.connectorCapabilities;
    state.feishuOAuthEnabled = connectorCapabilities
      && typeof connectorCapabilities.feishuOAuthInstallation === 'boolean'
      ? connectorCapabilities.feishuOAuthInstallation
      : null;
    syncFeishuOAuthAvailability();
    els.feishuStatus.textContent = feishuConfigured === undefined
      ? '详情受保护'
      : (feishuConfigured ? '已配置' : '未配置');
    els.feishuDetail.textContent = notifications === undefined
      ? '生产环境不公开配置详情'
      : (notifications ? '出站通知已启用' : '仅回调基础能力或未启用');
    renderConnectorStatus(health || {});
    return health;
  }

  async function loadInstallation() {
    els.installation.replaceChildren();
    setVisible(els.refreshOAuth, false);
    setVisible(els.revokeOAuth, false);
    if (state.feishuOAuthEnabled === false) {
      child(els.installation, node('span', 'muted', '当前服务未启用 Feishu OAuth，部署管理员完成配置后才能安装。'));
      return;
    }
    try {
      const result = await request('/v1/connectors/feishu/installation');
      const installation = result && result.installation;
      if (!installation) {
        child(els.installation, node('span', 'muted', '当前租户尚未完成 OAuth 安装。'));
        return;
      }
      const status = node(
        'span',
        'status-pill ' + (installation.status === 'active' ? 'status-ok' : 'status-error'),
        installation.status === 'active' ? '已安装' : '已撤销',
      );
      child(els.installation, status);
      const meta = node('div', 'meta');
      child(meta, node('span', '', '租户：' + text(installation.tenantName || installation.tenantId)));
      child(meta, node('span', '', '安装于：' + formatDate(installation.createdAt)));
      if (Array.isArray(installation.scopes) && installation.scopes.length) {
        child(meta, node('span', '', '权限：' + installation.scopes.join(', ')));
      }
      child(els.installation, meta);
      if (installation.status === 'active') {
        setVisible(els.refreshOAuth, true);
        setVisible(els.revokeOAuth, true);
      }
    } catch (error) {
      if (error && error.status === 404 && error.code === 'feishu_installation_not_found') {
        child(els.installation, node('span', 'muted', '当前租户尚未完成 OAuth 安装。'));
      } else if (error && error.status === 404) {
        child(els.installation, node('span', 'muted', 'Feishu OAuth 服务状态不一致，请检查工作台和 API 是否为同一版本。'));
      } else if (error && error.status === 403) {
        child(els.installation, node('span', 'muted', '当前身份没有查看 Feishu 安装状态的权限。'));
      } else {
        child(els.installation, node('span', 'muted', '安装状态暂时不可用，请稍后刷新。'));
      }
    }
  }

  async function startFeishuOAuth() {
    if (state.feishuOAuthEnabled === false) {
      toast('当前服务未启用 Feishu OAuth，无法开始安装。', 'error');
      return;
    }
    els.startOAuth.disabled = true;
    try {
      const result = await request('/v1/connectors/feishu/oauth/start?returnTo=%2Fapp%2F');
      const authorizationUrl = result && result.authorizationUrl;
      if (typeof authorizationUrl !== 'string') throw new Error('服务未返回 Feishu 授权地址');
      const parsed = new URL(authorizationUrl, window.location.origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
        throw new Error('授权地址协议不安全');
      }
      // The one-time state value remains only in the redirect URL and is
      // never rendered, persisted, or logged by the workbench.
      window.location.assign(parsed.toString());
    } catch (error) {
      toast(errorMessage(error), 'error');
      els.startOAuth.disabled = false;
    }
  }

  async function revokeFeishuOAuth() {
    if (!window.confirm('确认撤销当前租户的 Feishu 安装？服务端会保留审计记录，但停止使用该凭据。')) return;
    els.revokeOAuth.disabled = true;
    try {
      await request('/v1/connectors/feishu/installation', { method: 'DELETE' });
      await loadInstallation();
      toast('Feishu 安装已撤销');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      els.revokeOAuth.disabled = false;
    }
  }

  async function refreshFeishuOAuth() {
    els.refreshOAuth.disabled = true;
    try {
      await request('/v1/connectors/feishu/installation/refresh', { method: 'POST', body: jsonBody({}) });
      await loadInstallation();
      toast('Feishu 凭据已刷新');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      els.refreshOAuth.disabled = false;
    }
  }

  function renderConnectorStatus(health) {
    els.connectorStatus.replaceChildren();
    const rows = [
      ['API 服务', health.status === 'ok', health.status === 'ok' ? '可响应请求' : '请检查服务日志'],
      ['关键词检索', health.searchMode, health.searchMode === 'sqlite_fts5' ? 'SQLite FTS5' : '生产环境不公开能力详情'],
      ['证据问答', health.llmEnabled, health.llmEnabled === undefined ? '生产环境不公开模型配置' : (health.llmEnabled ? 'LLM 已启用，仍执行引用门控' : 'LLM 未启用，将返回 evidence-only')],
      ['飞书回调', health.feishuConfigured, health.feishuConfigured === undefined ? '生产环境不公开配置详情' : (health.feishuConfigured ? 'Verification Token 已配置' : '尚未配置凭据')],
      ['飞书通知', health.feishuNotificationsEnabled, health.feishuNotificationsEnabled === undefined ? '生产环境不公开配置详情' : (health.feishuNotificationsEnabled ? '提醒可发送到飞书' : '未启用出站通知')],
    ];
    rows.forEach(([label, capability, detail]) => {
      const active = capability === true || capability === 'sqlite_fts5';
      const protectedDetail = capability === undefined;
      const card = node('div', 'connector-card');
      const title = node('strong', '', label);
      const status = node('span', 'status-pill ' + (protectedDetail ? 'status-idle' : (active ? 'status-ok' : 'status-idle')), protectedDetail ? '受保护' : (active ? '可用' : '未启用'));
      const line = node('div', 'status-line');
      child(line, title); child(line, status);
      child(card, line); child(card, node('p', '', detail));
      child(els.connectorStatus, card);
    });
    els.callbackUrl.textContent = window.location.origin + '/v1/connectors/feishu/events';
  }

  async function connect() {
    const mode = els.authMode.value;
    const tenant = els.tenant.value.trim();
    const user = els.user.value.trim();
    const token = els.token.value.trim();
    if (mode === 'trusted_headers' && (!tenant || !user)) {
      toast('请填写租户 ID 和用户 ID', 'error');
      return;
    }
    if (mode === 'bearer' && !token) {
      toast('Bearer 模式需要填写访问令牌', 'error');
      return;
    }
    if (mode === 'bearer' && /\s/u.test(token)) {
      toast('Bearer 令牌不能包含空白字符', 'error');
      return;
    }
    state.authMode = mode;
    state.tenantId = tenant;
    state.userId = user;
    state.token = token;
    state.remember = els.remember.checked;
    setBusy(els.identityForm, true);
    setConnection('idle', '连接中…');
    try {
      await loadHealth();
      // /health is intentionally public, so probe an authenticated read
      // before presenting the session as connected. This catches expired,
      // malformed, or production-mode-mismatched credentials early.
      await request('/v1/assets?limit=1');
      state.connected = true;
      persistSession();
      // Keep the credential in the in-memory request state only; do not leave
      // it sitting in a form control where browser tooling/autofill can copy
      // it accidentally.
      els.token.value = '';
      els.workspaceLabel.textContent = tenant || 'Bearer token 声明';
      els.workspaceUser.textContent = user ? '当前用户：' + user : '当前用户由令牌声明决定';
      setVisible(els.setup, false);
      setVisible(els.workspace, true);
      setConnection('ok', '已连接');
      els.assetIdempotency.value = randomKey('asset');
      setDefaultReminderTimes();
      await Promise.allSettled([loadAssets(), loadReminders(), loadInstallation()]);
      toast('工作区已连接');
    } catch (error) {
      setConnection('error', '连接失败');
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(els.identityForm, false);
      syncAuthMode();
    }
  }

  function errorMessage(error) {
    return error && error.message ? error.message : '请求失败，请稍后重试';
  }

  async function loadAssets(options) {
    const append = Boolean(options && options.append);
    const cursor = append ? state.assetCursor : null;
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    if (els.assetFilterVisibility.value) query.set('visibility', els.assetFilterVisibility.value);
    const result = await request('/v1/assets?' + query.toString());
    const rows = result && Array.isArray(result.assets) ? result.assets : [];
    state.assetRows = append ? state.assetRows.concat(rows) : rows;
    state.assetCursor = result && typeof result.nextCursor === 'string' ? result.nextCursor : null;
    renderAssets(state.assetRows);
    els.assetPageNote.textContent = state.assetRows.length ? '已显示 ' + state.assetRows.length + ' 条' : '';
    setVisible(els.loadMoreAssets, Boolean(state.assetCursor));
  }

  function renderAssets(assets) {
    els.assetList.replaceChildren();
    if (!assets.length) {
      child(els.assetList, node('div', 'empty-state', '还没有可见记忆。可以先在左侧写入一条。'));
      return;
    }
    assets.forEach((asset) => {
      const card = node('article', 'item-card');
      const header = node('div', 'item-card-header');
      child(header, node('h3', '', asset.title || '未命名资产'));
      child(header, node('span', 'chip ' + (asset.visibility === 'tenant' ? 'chip-tenant' : 'chip-owner'), asset.visibility === 'tenant' ? '租户共享' : '仅所有者'));
      child(card, header);
      const preview = text(asset.redactedContent || '').replace(/\s+/gu, ' ').slice(0, 180);
      child(card, node('p', '', preview + (text(asset.redactedContent).length > 180 ? '…' : '')));
      const meta = node('div', 'meta');
      child(meta, node('span', '', formatDate(asset.createdAt)));
      child(meta, node('span', '', '脱敏发现 ' + text(asset.secretFindingCount || 0)));
      if (Array.isArray(asset.sources) && asset.sources[0] && asset.sources[0].type) {
        child(meta, node('span', '', '来源：' + asset.sources[0].type));
      }
      child(card, meta);
      const actions = node('div', 'item-actions');
      const detailButton = node('button', 'button button-quiet button-small', '查看详情');
      detailButton.type = 'button';
      detailButton.addEventListener('click', () => void showAssetDetail(asset.id));
      child(actions, detailButton);
      // The API remains the authority for ownership. Showing the action for
      // every visible row lets Bearer sessions delete their own assets even
      // when the user ID is intentionally not duplicated in the form.
      const deleteButton = node('button', 'button button-danger button-small', '删除');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', () => void deleteAsset(asset.id, asset.title));
      child(actions, deleteButton);
      child(card, actions);
      child(els.assetList, card);
    });
  }

  async function showAssetDetail(id) {
    try {
      const result = await request('/v1/assets/' + encodeURIComponent(id));
      const asset = result && result.asset;
      if (!asset) throw new Error('资产详情为空');
      els.assetDetail.dataset.id = asset.id;
      els.assetDetail.replaceChildren();
      child(els.assetDetail, node('h3', '', asset.title || '资产详情'));
      const meta = node('div', 'meta');
      child(meta, node('span', '', 'ID：' + asset.id));
      child(meta, node('span', '', '创建于 ' + formatDate(asset.createdAt)));
      child(els.assetDetail, meta);
      child(els.assetDetail, node('p', 'detail-content', asset.redactedContent || ''));
      if (Array.isArray(asset.sources) && asset.sources.length) {
        const sources = node('div', 'meta');
        asset.sources.forEach((source) => {
          const value = source && source.url;
          const safeUrl = toSafeHttpUrl(value);
          if (safeUrl) {
            const link = node('a', '', safeUrl);
            link.href = safeUrl;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            child(sources, link);
          } else if (source && source.type) {
            child(sources, node('span', 'chip', '来源：' + source.type));
          }
        });
        child(els.assetDetail, sources);
      }
      setVisible(els.assetDetail, true);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function deleteAsset(id, title) {
    if (!window.confirm('确认删除“' + text(title) + '”？删除后搜索和详情都不可恢复。')) return;
    try {
      await request('/v1/assets/' + encodeURIComponent(id), { method: 'DELETE' });
      if (els.assetDetail.dataset.id === id) setVisible(els.assetDetail, false);
      await loadAssets();
      toast('资产已删除');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function writeAsset(event) {
    event.preventDefault();
    const title = els.assetTitle.value.trim();
    const content = els.assetContent.value.trim();
    if (!title || !content) return;
    const key = els.assetIdempotency.value.trim() || randomKey('asset');
    els.assetIdempotency.value = key;
    setBusy(els.assetForm, true);
    clearResult(els.assetWriteResult);
    try {
      const result = await request('/v1/assets', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: jsonBody({
          title,
          content,
          visibility: els.assetVisibility.value,
          source: {
            type: els.assetSourceType.value,
            ...(els.assetSourceUrl.value.trim() ? { url: els.assetSourceUrl.value.trim() } : {}),
          },
        }),
      });
      const asset = result && result.asset;
      setResult(els.assetWriteResult, '已保存：' + text(asset && asset.title) + '\n脱敏发现：' + text(asset && asset.secretFindingCount) + '\n' + text(asset && asset.redactedContent), 'success');
      els.assetTitle.value = '';
      els.assetContent.value = '';
      els.assetSourceUrl.value = '';
      els.assetIdempotency.value = randomKey('asset');
      await loadAssets();
      toast(result && result.created === false ? '幂等重放：返回已有资产' : '记忆已保存');
    } catch (error) {
      setResult(els.assetWriteResult, errorMessage(error), 'error');
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(els.assetForm, false);
    }
  }

  async function search(event) {
    event.preventDefault();
    const query = els.searchQuery.value.trim();
    if (!query) return;
    setBusy(els.searchForm, true);
    clearResult(els.searchResult);
    try {
      const result = await request('/v1/search', {
        method: 'POST',
        body: jsonBody({ query, limit: Number(els.searchLimit.value) || 8 }),
      });
      const evidence = result && Array.isArray(result.evidence) ? result.evidence : [];
      setResult(els.searchResult, '检索模式：' + text(result && result.mode) + '\n授权证据：' + evidence.length + ' 条', 'success');
      renderEvidence(evidence);
    } catch (error) {
      setResult(els.searchResult, errorMessage(error), 'error');
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(els.searchForm, false);
    }
  }

  async function answer(event) {
    event.preventDefault();
    const query = els.answerQuery.value.trim();
    if (!query) return;
    setBusy(els.answerForm, true);
    clearResult(els.answerResult);
    try {
      const result = await request('/v1/answers', {
        method: 'POST',
        body: jsonBody({ query, limit: 8 }),
      });
      const status = text(result && result.status);
      const reason = result && result.degradedReason ? '\n降级原因：' + result.degradedReason : '';
      setResult(els.answerResult, '状态：' + (status || 'unknown') + reason + '\n\n' + text(result && result.answer), status === 'answered' ? 'success' : '');
      renderEvidence(result && Array.isArray(result.evidence) ? result.evidence : []);
    } catch (error) {
      setResult(els.answerResult, errorMessage(error), 'error');
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(els.answerForm, false);
    }
  }

  function renderEvidence(evidence) {
    els.evidenceList.replaceChildren();
    if (!evidence.length) {
      child(els.evidenceList, node('div', 'empty-state', '没有找到当前身份有权查看的证据。'));
      return;
    }
    evidence.forEach((item, index) => {
      const card = node('article', 'evidence-card');
      child(card, node('span', 'citation', item.citationId || '[S' + (index + 1) + ']'));
      child(card, node('h3', '', item.title || '未命名资产'));
      child(card, node('p', '', item.snippet || ''));
      const meta = node('div', 'meta');
      child(meta, node('span', '', '相关度 ' + formatScore(item.score)));
      child(meta, node('span', '', formatDate(item.createdAt)));
      if (Array.isArray(item.sources)) {
        item.sources.forEach((source) => {
          const safeUrl = toSafeHttpUrl(source && source.url);
          if (safeUrl) {
            const link = node('a', '', '打开来源');
            link.href = safeUrl;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            child(meta, link);
          }
        });
      }
      child(card, meta);
      child(els.evidenceList, card);
    });
  }

  function formatScore(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : '—';
  }

  function toSafeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = new URL(value, window.location.origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  function formatDate(value) {
    if (!value) return '时间未知';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return text(value);
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function localInputToIso(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('请输入有效的日期时间');
    return date.toISOString();
  }

  function setDefaultReminderTimes() {
    if (els.reminderStarts.value) return;
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const remind = new Date(Date.now() + 30 * 60 * 1000);
    els.reminderStarts.value = toLocalInput(start);
    els.reminderAt.value = toLocalInput(remind);
  }

  function toLocalInput(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  async function writeReminder(event) {
    event.preventDefault();
    setBusy(els.reminderForm, true);
    clearResult(els.reminderWriteResult);
    try {
      const startsAt = localInputToIso(els.reminderStarts.value);
      const remindAt = els.reminderAt.value ? localInputToIso(els.reminderAt.value) : undefined;
      const payload = { title: els.reminderTitle.value.trim(), startsAt };
      if (remindAt) payload.remindAt = remindAt;
      const result = await request('/v1/reminders', { method: 'POST', body: jsonBody(payload) });
      const reminder = result && result.reminder;
      setResult(els.reminderWriteResult, '已创建：' + text(reminder && reminder.title) + '\n提醒时间：' + formatDate(reminder && reminder.remindAt), 'success');
      els.reminderTitle.value = '';
      await loadReminders();
      toast('提醒已创建');
    } catch (error) {
      setResult(els.reminderWriteResult, errorMessage(error), 'error');
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(els.reminderForm, false);
    }
  }

  async function loadReminders() {
    const query = new URLSearchParams({ limit: '50' });
    if (els.reminderFilterStatus.value) query.set('status', els.reminderFilterStatus.value);
    const result = await request('/v1/reminders?' + query.toString());
    renderReminders(result && Array.isArray(result.reminders) ? result.reminders : []);
  }

  function renderReminders(reminders) {
    els.reminderList.replaceChildren();
    if (!reminders.length) {
      child(els.reminderList, node('div', 'empty-state', '还没有提醒。可以在左侧安排一个。'));
      return;
    }
    reminders.forEach((reminder) => {
      const card = node('article', 'item-card');
      const header = node('div', 'item-card-header');
      child(header, node('h3', '', reminder.title || '未命名提醒'));
      child(header, node('span', 'chip', STATUS_LABELS[reminder.status] || reminder.status));
      child(card, header);
      child(card, node('p', '', '开始：' + formatDate(reminder.startsAt) + ' · 提醒：' + formatDate(reminder.remindAt)));
      const actions = node('div', 'item-actions');
      if (reminder.status === 'scheduled' || reminder.status === 'needs_confirmation') {
        const select = document.createElement('select');
        select.className = 'status-select';
        const transitions = reminder.status === 'needs_confirmation'
          ? ['needs_confirmation', 'scheduled', 'completed', 'cancelled']
          : ['scheduled', 'completed', 'cancelled'];
        transitions.forEach((status) => {
          const option = document.createElement('option');
          option.value = status;
          option.textContent = STATUS_LABELS[status];
          option.selected = status === reminder.status;
          select.append(option);
        });
        select.addEventListener('change', () => void updateReminderStatus(reminder.id, select, select.value));
        child(actions, select);
      }
      const deleteButton = node('button', 'button button-danger button-small', '删除');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', () => void deleteReminder(reminder.id, reminder.title));
      child(actions, deleteButton);
      child(card, actions);
      child(els.reminderList, card);
    });
  }

  async function updateReminderStatus(id, select, status) {
    select.disabled = true;
    try {
      await request('/v1/reminders/' + encodeURIComponent(id) + '/status', {
        method: 'POST',
        body: jsonBody({ status }),
      });
      await loadReminders();
      toast('提醒状态已更新');
    } catch (error) {
      toast(errorMessage(error), 'error');
      await loadReminders();
    }
  }

  async function deleteReminder(id, title) {
    if (!window.confirm('确认删除提醒“' + text(title) + '”？')) return;
    try {
      await request('/v1/reminders/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadReminders();
      toast('提醒已删除');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function activateTab(tabName) {
    document.querySelectorAll('[data-tab]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === tabName));
    document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === tabName));
  }

  function bindEvents() {
    els.authMode.addEventListener('change', syncAuthMode);
    els.identityForm.addEventListener('submit', (event) => { event.preventDefault(); void connect(); });
    els.assetForm.addEventListener('submit', (event) => void writeAsset(event));
    els.searchForm.addEventListener('submit', (event) => void search(event));
    els.answerForm.addEventListener('submit', (event) => void answer(event));
    els.reminderForm.addEventListener('submit', (event) => void writeReminder(event));
    $('refresh-all').addEventListener('click', () => {
      if (!state.connected) return toast('请先连接工作区', 'error');
      void refreshAll();
    });
    $('sign-out').addEventListener('click', clearSession);
    $('reload-assets').addEventListener('click', () => void loadAssets().catch((error) => toast(errorMessage(error), 'error')));
    els.assetFilterVisibility.addEventListener('change', () => void loadAssets().catch((error) => toast(errorMessage(error), 'error')));
    els.loadMoreAssets.addEventListener('click', () => {
      els.loadMoreAssets.disabled = true;
      void loadAssets({ append: true })
        .catch((error) => toast(errorMessage(error), 'error'))
        .finally(() => { els.loadMoreAssets.disabled = false; });
    });
    $('reload-reminders').addEventListener('click', () => void loadReminders().catch((error) => toast(errorMessage(error), 'error')));
    els.reminderFilterStatus.addEventListener('change', () => void loadReminders().catch((error) => toast(errorMessage(error), 'error')));
    $('reload-health').addEventListener('click', () => void refreshHealth());
    els.startOAuth.addEventListener('click', () => void startFeishuOAuth());
    els.refreshOAuth.addEventListener('click', () => void refreshFeishuOAuth());
    els.revokeOAuth.addEventListener('click', () => void revokeFeishuOAuth());
    document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  }

  async function refreshAll() {
    try {
      await loadHealth();
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    const results = await Promise.allSettled([loadAssets(), loadReminders(), loadInstallation()]);
    if (results.some((result) => result.status === 'rejected')) toast('部分数据刷新失败，请检查服务状态', 'error');
    else toast('数据已刷新');
  }

  async function refreshHealth() {
    try {
      await loadHealth();
      await loadInstallation();
      toast('连接器状态已刷新');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function handleOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('feishu');
    if (!result) return;
    // Remove the one-time status marker from the address bar; no OAuth code or
    // state is retained by the workbench.
    try { window.history.replaceState({}, document.title, window.location.pathname); } catch { /* noop */ }
    if (result === 'connected') toast('Feishu 租户安装成功，请重新连接工作区查看状态');
    else if (result === 'error') toast('Feishu 安装未完成，请检查服务端提示后重试', 'error');
  }

  syncAuthMode();
  loadSavedSession();
  bindEvents();
  handleOAuthReturn();
})();
