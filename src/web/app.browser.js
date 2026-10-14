'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="bcp-token"]').content;
  let state = null, selectedType = 'video', connected = false, pendingStart = false, pollTimer, pollBusy = false, toastTimer;
  const phases = { starting: '正在准备', preflight: '检查原生线路', coarse: '筛选候选节点', rescue: '补测超时节点', refine: '复筛入围节点', confirm: '确认下载表现' };
  const reasons = { 'target-reached': '达到目标速率', completed: '本轮完成', deadline: '到达总时限', 'phase-budget': '为复筛与确认保留时间',
    budget: '达到目标流量预算', 'unsafe-response': '响应超出请求范围，保护性停止', 'stopped-by-user': '已手动停止',
    'network-changed': '网络已变化', 'lease-lost': '另一任务已接管', 'candidates-exhausted': '已测完本轮候选',
    'expansion-disabled': '已测完短名单', 'no-valid-sample': '没有可用样本', 'native-invalid': '原生资源已失效', 'internal-error': '任务异常' };
  const errors = { 'session-expired': '本机会话已变化，请刷新页面。', busy: '已有测速任务，请等它完成或先停止。',
    'no-sample': '请先在 B 站播放约 10 秒。', 'no-fresh-sample': '样本已过期，请回到视频产生新请求。',
    'sample-invalid': '原生资源已失效，请打开新的视频请求。', 'already-decided': '当前资源已有有效选择。',
    'cellular-blocked': '当前设置不允许蜂窝完整探索。', disabled: '优化已关闭，请先在设置中启用。', paused: '改写已暂停。',
    'store-unavailable': 'Surge 本机存储不可写。', 'invalid-setting': '设置值不在支持范围内。', 'select-resource': '请先选择新鲜的视频或音频样本。',
    'internal-error': '本机脚本运行失败，请查看 Surge 脚本日志。' };
  const statusNames = { ok: '有效', timeout: '超时', forbidden: '403', 'not-found': '404', 'range-ignored': '忽略 Range',
    'rate-limited': '限流', 'server-error': '服务错误', redirect: '重定向', 'error-body': '错误内容',
    'length-mismatch': '长度异常', 'range-mismatch': '区间异常', connect: '连接失败', dns: 'DNS 失败', tls: 'TLS 失败' };
  const typeName = (type) => type === 'audio' ? '音频' : type === 'video' ? '视频' : '媒体';
  const current = () => state && state.current.find((r) => r.type === selectedType);
  const age = (at) => { if (!at) return '—'; const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`; };
  const speed = (value) => typeof value === 'number' && Number.isFinite(value) ? `${value >= 100 ? Math.round(value) : value.toFixed(1)} Mbps` : '—';
  const bytes = (value) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${Math.round((value || 0) / 1024)} KiB`;
  const hostName = (host) => (host || '').replace(/\.bilivideo\.com$/, '').replace(/\.akamaized\.net$/, ' (akamai)');
  function badge(id, text, kind) { $(id).textContent = text; $(id).className = `badge ${kind || 'neutral'}`; }
  function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
  async function api(path, body, timeout = 8000) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: Object.assign({ 'X-BCP-Token': token }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
      const data = await r.json();
      if (!r.ok) throw new Error(errors[data.error || data.status] || data.error || data.status || '请求失败');
      return data;
    } catch (e) { if (e.name === 'AbortError') throw new Error('等待本机响应超时；任务可能仍在运行，请查看状态。'); throw e; }
    finally { clearTimeout(timer); }
  }
  async function poll() {
    clearTimeout(pollTimer);
    if (pollBusy || document.hidden) return;
    pollBusy = true;
    try { state = await api('/api/status'); connected = true; render(); }
    catch (e) {
      connected = false; $('connection-dot').className = 'dot offline'; $('connection-text').textContent = '暂时无法连接本机 Surge';
      $('notice').hidden = false; $('notice').textContent = e.message.includes('会话') ? e.message : '请保持 Surge 运行并启用本模块。连接恢复后会自动更新，勿重复启动测速。';
      setActionState();
    } finally { pollBusy = false; if (!document.hidden) pollTimer = setTimeout(poll, state && state.job.active || pendingStart ? 2000 : 5000); }
  }
  function setActionState() {
    const r = current(), active = state && state.job.active || pendingStart;
    const blocked = !connected || !state || !r || !r.fresh || active || !state.settings.enabled || state.paused;
    $('quick').disabled = !!blocked; $('full').disabled = !!blocked;
    $('stop').disabled = !connected || (!active);
    $('save-settings').disabled = !!active || !connected;
    $('clear-network').disabled = !!active || !connected;
  }
  function render() {
    $('connection-dot').className = 'dot connected';
    $('connection-text').textContent = state.preview ? '交互预览 · 模拟网络' : `Surge 已连接 · ${state.network.label}`;
    $('version').textContent = `v${state.version}`;
    $('notice').hidden = !state.preview && state.settings.enabled && !state.paused;
    $('notice').textContent = state.preview ? '这是本地交互预览，节点成绩为模拟数据。' : !state.settings.enabled ? '优化已关闭，媒体请求保持原样。' : '改写已暂停，恢复后才会使用已确认的选择。';
    $('target-speed').textContent = speed(state.settings.targetMbps);
    $('tab-video').setAttribute('aria-pressed', String(selectedType === 'video'));
    $('tab-audio').setAttribute('aria-pressed', String(selectedType === 'audio'));
    const r = current(), label = typeName(selectedType);
    $('quick').firstElementChild.textContent = r && r.confirmed ? `重新测速${label}` : `优化当前${label}`;
    if (!r) {
      $('current-title').textContent = `先播放一段${selectedType === 'audio' ? '带声音的' : ''}视频`;
      $('current-explanation').textContent = '在 B 站播放约 10 秒，再回到这里。当前没有这一类型的媒体样本。';
      $('current-host').textContent = '尚未收到样本'; $('sample-meta').textContent = '只在本机采样，不上传播放链接';
      $('current-speed').textContent = '—'; $('decision-ttl').textContent = '—'; badge('current-badge', '等待样本');
    } else {
      const freshLabel = r.fresh ? '样本新鲜' : '样本已过期';
      $('current-host').textContent = r.selectedHost;
      $('sample-meta').textContent = `${label} ${r.representationId || ''} · ${age(r.sampleAt)} · ${freshLabel}`;
      $('current-speed').textContent = speed(r.score);
      const ttl = r.decisionExpiresAt ? Math.max(0, Math.ceil((r.decisionExpiresAt - state.now) / 60000)) : null;
      $('decision-ttl').textContent = ttl ? `${ttl} 分钟` : '—';
      if (!state.settings.enabled || state.paused) {
        $('current-title').textContent = '保持原始播放路径'; badge('current-badge', '已暂停', 'warning');
        $('current-explanation').textContent = '恢复优化后，才会将后续新请求交给已确认的节点。';
      } else if (r.confirmed && r.changed) {
        $('current-title').textContent = `已选择${label}线路`; badge('current-badge', r.reason.includes('fallback') ? '备用线路' : '已确认', 'good');
        $('current-explanation').textContent = '后续新请求使用这条线路。实际缓冲和拖动体验，需要在测速结束后观察。';
      } else if (r.confirmed) {
        $('current-title').textContent = r.enoughFast ? '原生线路已达到目标' : '保留当前原生线路'; badge('current-badge', '保持原生', 'good');
        $('current-explanation').textContent = '本轮没有必要切换。这个判断只适用于这里显示的媒体资源。';
      } else if (r.changed) {
        $('current-title').textContent = '正在尝试历史线路'; badge('current-badge', '当前资源未确认', 'warning');
        $('current-explanation').textContent = '这是按历史偏好尝试的节点，当前资源还没有完成确认测速。';
      } else {
        $('current-title').textContent = `尚未确认当前${label}`; badge('current-badge', r.fresh ? '待优化' : '等待新样本', r.fresh ? 'neutral' : 'warning');
        $('current-explanation').textContent = r.fresh ? `当前仍走原生节点。点击优化，比较同一${label}资源在候选 CDN 上的表现。` : '回到 B 站继续播放或拖动到未缓冲位置，再重新测速。';
      }
    }
    $('action-hint').textContent = state.job.active || pendingStart ? '已有测速任务，等待完成或使用停止按钮。' :
      `快速选择目标预算 ${state.network.type === 'cellular' ? state.limits.cellularTargetMiB : state.limits.quickTargetMiB} MiB／资源；当前入口只测所选的${label}。`;
    renderJob(); renderReport(); renderHistory(); setActionState();
    $('pause').textContent = state.paused ? '恢复改写' : '暂停改写';
    $('settings-limits').textContent = `当前设备：粗筛并发 ${state.limits.discoveryConcurrency}，确认并发 ${state.limits.confirmConcurrency}；完整探索目标预算 ${state.limits.discoveryTargetMiB} MiB。`;
  }
  function renderJob() {
    const j = state.job, active = j.active || pendingStart;
    $('job-card').hidden = !active;
    if (!active) return;
    $('job-title').textContent = j.active ? `${typeName(j.mediaType)} · ${j.action === 'full' ? '完整探索' : '快速选择'}` : '启动测速';
    $('job-phase').textContent = phases[j.phase] || '正在启动任务';
    $('job-elapsed').textContent = j.startedAt ? `${Math.max(0, Math.floor((state.now - j.startedAt) / 1000))} 秒` : '';
    const phase = ['preflight', 'rescue', 'starting'].includes(j.phase) ? 'coarse' : j.phase;
    document.querySelectorAll('[data-phase]').forEach((el) => el.classList.toggle('active', el.dataset.phase === phase));
    const bar = $('job-progress');
    if (j.action === 'full' && j.candidates && phase === 'coarse') { bar.max = j.candidates; bar.value = Math.min(j.nodesStarted || 0, j.candidates); }
    else bar.removeAttribute('value');
    $('job-counts').textContent = j.active ? `已测 ${j.nodesStarted || 0} 个节点 · 请求完成 ${j.completed || 0} / ${j.started || 0}` : '正在等待任务响应';
    $('job-updated').textContent = j.updatedAt ? `更新于 ${age(j.updatedAt)}` : '';
  }
  function renderRows(list) {
    const body = $('results'); body.replaceChildren();
    $('results-wrap').hidden = !list.length; $('results-empty').hidden = !!list.length;
    for (const r of list) {
      const tr = document.createElement('tr'), host = document.createElement('td'), rate = document.createElement('td'), status = document.createElement('td');
      const name = document.createElement('span'); name.className = 'node-name'; name.textContent = hostName(r.host); host.append(name);
      const sub = document.createElement('span'); sub.className = 'node-sub'; sub.textContent = phases[r.stage] || '采样'; host.append(sub);
      rate.textContent = speed(r.status === 'ok' ? r.mbps : null);
      const tag = document.createElement('span'); tag.className = 'badge ' + (r.confirmed ? 'good' : r.status === 'ok' ? 'neutral' : 'warning');
      tag.textContent = r.confirmed ? '已确认' : r.status === 'ok' ? '待确认' : statusNames[r.status] || '未完成'; status.append(tag);
      tr.append(host, rate, status); body.append(tr);
    }
  }
  function renderReport() {
    const r = current(), run = state.lastRun, live = state.job.active && r && state.job.resourceKey === r.resourceId;
    const report = run && (run.resources || []).find((x) => r && x.resourceKey === r.resourceId);
    $('report-metrics').hidden = !report || live; $('traffic-note').hidden = !report || live;
    if (live) {
      $('report-summary').textContent = '候选成绩正在更新'; $('report-detail').textContent = '粗筛和复筛成绩用于入围，只有确认通过的节点才可成为播放选择。';
      badge('report-badge', '进行中'); renderRows(state.job.results || []);
    } else if (!report) {
      $('report-summary').textContent = `还没有当前${typeName(selectedType)}的结果`;
      $('report-detail').textContent = run ? '上一轮报告不属于当前选中的资源。换视频、画质或签名后，需要新的确认结果。' : '视频和音频分别选择，音频的好成绩不会代表视频已经优化。';
      badge('report-badge', '尚未确认'); renderRows([]);
    } else {
      const accepted = !!report.winner && report.committed;
      $('report-summary').textContent = accepted ? (report.winner === report.nativeHost ? '已确认保留原生节点' : '已确认本轮可用节点') : '这一轮尚未产生可用选择';
      badge('report-badge', accepted ? (report.partial ? '部分探索 · 已确认' : '已确认') : '未完成确认', accepted ? 'good' : 'warning');
      $('report-detail').textContent = `${age(run.finishedAt)} · ${reasons[report.stopReason] || report.stopReason || '结束'}。` +
        (report.partial ? '尚未覆盖全部候选，不能称为全局最快。' : accepted ? '这是本轮已测结果，不保证长期最优。' : '已获取的粗筛成绩可用于后续探索，但不会被当作已确认结果。');
      const c = report.coverage || {}, b = report.budget || {};
      $('coverage').textContent = `${c.valid || 0} / ${c.started || 0} / ${c.eligible || 0}`;
      $('traffic').textContent = bytes(b.observedBytes || 0);
      $('traffic-note').textContent = b.unobservableCount ? `${b.unobservableCount} 次失败请求的实际流量不可观测，另保留 ${bytes(b.unobservableBytes)} 估算。目标预算不是严格上限。` : '统计为可见响应正文，另有协议开销；目标预算不是严格上限。';
      renderRows(report.results || []);
    }
  }
  function renderHistory() {
    const container = $('history'); container.replaceChildren(); $('history-count').textContent = state.history.length;
    if (!state.history.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '当前网络还没有可复用的确认成绩。'; container.append(p); }
    for (const r of state.history) {
      const row = document.createElement('div'); row.className = 'history-row';
      const name = document.createElement('span'); name.className = 'node-name'; name.textContent = hostName(r.host);
      const value = document.createElement('span'); value.className = 'history-score'; value.textContent = speed(r.confirmedMbps);
      row.append(name, value); container.append(row);
    }
  }
  let resolveConfirm;
  function confirmAction(title, message, label) {
    $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-ok').textContent = label || '继续';
    $('confirm-dialog').showModal(); return new Promise((resolve) => { resolveConfirm = resolve; });
  }
  function finishConfirm(value) { $('confirm-dialog').close(); if (resolveConfirm) { resolveConfirm(value); resolveConfirm = null; } }
  async function command(action, resourceId) {
    const starting = ['quick', 'quick-force', 'full'].includes(action);
    if (starting) { if (pendingStart || state.job.active) return; pendingStart = true; render(); }
    try {
      const answer = await api('/api/control', { action, resourceId }, starting ? 90000 : 8000);
      state = answer.snapshot; connected = true;
      toast(errors[answer.status] || ({ 'stop-requested': '已停止新增探测，等待在途请求结束。', resumed: '改写已恢复。', cleared: '本网络的选择与历史已清除。', selected: '已完成本轮选择。', 'target-reached': '已确认达到目标。' })[answer.status] || '操作已完成，请查看结果。');
    } catch (e) { toast(e.message); }
    finally { if (starting) pendingStart = false; if (state) render(); poll(); }
  }
  $('tab-video').onclick = () => { selectedType = 'video'; if (state) render(); };
  $('tab-audio').onclick = () => { selectedType = 'audio'; if (state) render(); };
  $('quick').onclick = () => { const r = current(); if (r) command(r.confirmed ? 'quick-force' : 'quick', r.resourceId); };
  $('full').onclick = async () => {
    const r = current(); if (!r) return;
    if (await confirmAction('探索更多候选', `针对所选${typeName(r.type)}探索全量候选，目标预算 ${state.limits.discoveryTargetMiB} MiB，总时限 ${state.limits.runDeadlineSeconds} 秒。会为复筛和确认保留时间；请保持页面在前台。`, '开始探索')) command('full', r.resourceId);
  };
  $('stop').onclick = () => command('stop');
  $('confirm-ok').onclick = () => finishConfirm(true); $('confirm-cancel').onclick = () => finishConfirm(false);
  $('confirm-dialog').addEventListener('cancel', (e) => { e.preventDefault(); finishConfirm(false); });
  $('settings-open').onclick = () => {
    if (!state) { toast('等待连接本机 Surge。'); return; }
    const s = state.settings;
    $('setting-enabled').checked = s.enabled; $('setting-region').value = s.region; $('setting-target').value = s.targetMbps;
    $('setting-mode').value = s.mode; $('setting-history').value = s.historyPolicy;
    $('setting-cellular').checked = s.cellularDiscovery; $('setting-debug').checked = s.debug;
    $('settings-dialog').showModal();
  };
  $('settings-close').onclick = () => $('settings-dialog').close();
  $('settings-form').onsubmit = async (e) => {
    e.preventDefault(); $('save-settings').disabled = true;
    try {
      state = await api('/api/settings', { enabled: $('setting-enabled').checked, region: $('setting-region').value,
        targetMbps: Number($('setting-target').value), mode: $('setting-mode').value, historyPolicy: $('setting-history').value,
        cellularDiscovery: $('setting-cellular').checked, debug: $('setting-debug').checked });
      $('settings-dialog').close(); render(); toast('设置已保存在本机。');
    } catch (error) { toast(error.message); setActionState(); }
  };
  $('pause').onclick = () => command(state.paused ? 'resume' : 'pause');
  $('clear-network').onclick = async () => { if (await confirmAction('清除当前网络的历史？', '删除这个网络上的已确认选择和候选排行，原生播放继续。其他网络的记录不变。', '清除')) command('clear-network'); };
  $('install-help').onclick = () => $('install-dialog').showModal(); $('install-close').onclick = () => $('install-dialog').close();
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(pollTimer); else poll(); });
  poll();
})();
