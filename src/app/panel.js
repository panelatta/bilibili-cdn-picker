'use strict';

const S = require('../core/state');
const { version } = require('../../package.json');
const { formatAge, formatBytes, formatMbps, shortHost } = require('../core/format');
const { loadConfig, ensureMeta, currentNetwork } = require('./context');
const { normalizeAction } = require('../core/actions');

// Control panel (design §12). A periodic refresh only renders cached state;
// probing starts solely when the user taps the panel's refresh button.

const STATUS_TEXT = {
  'target-reached': '已确认，达到目标',
  selected: '已确认（低于目标，可播放）',
  'no-confirmed': '有可用样本，但未完成确认',
  'no-valid': '本轮无有效测速结果',
  'native-invalid': '原生样本已失效（403/404），等待新播放请求',
  'object-too-small': '资源过小，跳过测速',
  'insufficient-budget': '预算不足以完成确认',
  aborted: '已中止',
  failed: '任务异常结束，可稍后重试',
  disabled: '模块已关闭',
  paused: '改写已暂停',
  'manual-mode': '手动模式，未运行',
  'cellular-blocked': '蜂窝网络下未启用该探索',
  'no-sample': '没有媒体样本：先在 B 站 App 播放视频约 10 秒',
  'no-fresh-sample': '样本已过期：继续播放视频后再点按',
  'sample-invalid': '样本对原生节点也失效，等待新播放请求',
  'already-decided': '当前资源已有有效选择，未重复测速',
  'nothing-pending': '没有待测资源',
  busy: '已有任务在运行',
  'store-unavailable': '持久化存储不可写，未运行测速',
  'stop-requested': '已请求停止派发',
  resumed: '已恢复改写',
  cleared: '缓存已清空',
};

const STOP_TEXT = {
  completed: '完成',
  'target-reached': '达到目标',
  budget: '预算用尽',
  deadline: '到达截止时间',
  'network-changed': '网络已变化',
  'stopped-by-user': '用户停止',
  paused: '已暂停',
  'candidates-exhausted': '候选已用尽',
  'expansion-disabled': '未启用扩展',
  'no-valid-sample': '样本或网络无效',
  'native-invalid': '原生样本失效',
  'pool-saturated': '并发名额被占满',
  'unsafe-response': '响应超出请求范围，已停止后续下载',
  'lease-lost': '任务已失去运行权',
  'internal-error': '任务异常',
};

const MEDIA_TEXT = { video: '视频', audio: '音频', unknown: '媒体' };

function statusText(s) {
  return STATUS_TEXT[s] || s || '-';
}

function render(ctx, actionResult, title) {
  const store = ctx.store;
  const now = ctx.now();
  const loaded = loadConfig(store, ctx.argument);
  const config = loaded.config;
  const meta = ensureMeta(store, now, ctx.rng);
  const net = currentNetwork(ctx.network(), meta, config);
  const control = S.loadControl(store);
  const samples = S.loadSamples(store);
  const decisions = S.loadDecisions(store);
  const state = S.loadState(store);
  const lastRun = store.readJson(S.KEYS.lastRun, null);
  const profile = state.profiles[net.key] || null;
  const lines = [];

  const modeText = config.mode === 'adaptive' ? '自动模式' : '手动模式';
  let head = net.label + ' · ' + modeText + ' · 地区 ' + (config.region === 'NONE' ? '未设置' : config.region);
  if (!config.enabled) head += ' · 已关闭';
  else if (control.paused) head += ' · 已暂停';
  lines.push(head);
  if (ctx.environment && ctx.environment.system === 'iOS') {
    lines.push('iOS 并发限制 · 粗筛最多 2 · 复筛与确认串行');
  }
  const lease = store.readJson(S.KEYS.lease, null);
  const progress = store.readJson(S.KEYS.progress, null);
  if (lease && lease.runId && lease.expiresAt > now) {
    const seconds = Math.max(1, Math.ceil((lease.expiresAt - now) / 1000));
    const phaseNames = { starting: '准备', preflight: '原生预检', coarse: '粗筛', rescue: '补测', refine: '复筛', confirm: '确认' };
    lines.push('任务占用中 · 锁最迟 ' + seconds + ' 秒后到期；可点“停止测速”');
    if (progress && progress.runId === lease.runId) {
      lines.push('进度：' + (phaseNames[progress.phase] || progress.phase) + ' · 已完成 ' + progress.completed + ' / 已启动 ' + progress.started);
    }
  } else if (lease && lease.runId) {
    lines.push('上次任务未正常释放，锁已过期；下次点击可自动恢复');
  }
  const env = ctx.environment || {};
  lines.push('CDN Picker v' + version + ' · Surge ' + (env['surge-version'] || '未知') + ' · ' + (env.system || '未知系统'));

  // Current resources: newest sample per media type on this network.
  const latest = {};
  Object.keys(samples.items).forEach((k) => {
    const s = samples.items[k];
    if (s.networkKey !== net.key) return;
    if (!latest[s.mediaType] || latest[s.mediaType].capturedAt < s.capturedAt) latest[s.mediaType] = s;
  });
  ['video', 'audio', 'unknown'].forEach((type) => {
    const s = latest[type];
    if (!s) return;
    const d = decisions.items[s.key];
    const label = MEDIA_TEXT[type] + (s.representationId ? ' ' + s.representationId : '');
    if (d && d.networkKey === net.key && d.expiresAt > now) {
      const tag = d.provisional ? '临时' : d.enoughFast ? '已确认' : '已确认·低于目标';
      const target = d.winner === s.nativeHost ? '保持原生 ' + shortHost(d.winner) : shortHost(d.winner);
      lines.push(label + '：' + target + ' ' + formatMbps(d.score) + '（' + tag + '，备选 ' + d.backups.length + '）');
    } else {
      lines.push(label + '：未选择，原生 ' + shortHost(s.nativeHost));
    }
    lines.push('  样本 ' + formatAge(now - s.capturedAt) + (s.expiresAt > now ? '' : '（已过期）'));
  });
  if (!latest.video && !latest.audio && !latest.unknown) {
    lines.push('当前网络暂无媒体样本');
    lines.push('支持 HTTP:80 / HTTPS:443 的 /upgcxcode/…m4s 请求。');
    lines.push('只有 TCP/TLS 连接而无 HTTP 路径：检查原始 TCP 排除项、MITM 与握手错误。');
  }

  if (actionResult && actionResult.status && !(actionResult.resources && actionResult.resources.length)) {
    lines.push('本次：' + statusText(actionResult.status));
  }
  if (lastRun && S.isObject(lastRun) && lastRun.finishedAt) {
    const runName = lastRun.mode === 'full' ? '完整探索' : '快速选择';
    const r = (lastRun.resources || [])[0];
    let line = '上次' + runName + ' ' + formatAge(now - lastRun.finishedAt) + '：' + statusText(lastRun.status);
    if (lastRun.stopReason) line += '，停止：' + (STOP_TEXT[lastRun.stopReason] || lastRun.stopReason);
    lines.push(line);
    if (r && r.coverage) {
      let cov = '覆盖 有效 ' + r.coverage.valid + ' / 已启动 ' + r.coverage.started + ' / 合格 ' + r.coverage.eligible;
      if (r.mode === 'full') cov += r.complete ? '（完整）' : '（部分探索）';
      lines.push(cov);
    }
    const b = sumBudgets(lastRun.resources || []);
    if (b) {
      let traffic = '流量 可见 ' + formatBytes(b.observedBytes);
      if (b.unobservableCount) traffic += ' + 保守预留 ' + formatBytes(b.unobservableBytes) + '（' + b.unobservableCount + ' 次不可观测）';
      if (b.overrunCount) traffic += '，' + b.overrunCount + ' 次超出 Range';
      lines.push(traffic);
    }
  }
  if (profile) {
    lines.push('完整探索：' + (profile.lastFullScanAt ? formatAge(now - profile.lastFullScanAt) : '尚未完成') +
      (profile.explorationPending ? ' · 建议在 Wi-Fi 下完整探索' : ''));
  }
  const trigger = store.readJson(S.KEYS.trigger, null);
  if (config.mode === 'adaptive' && S.isObject(trigger) && trigger.lastAt) {
    lines.push('自动触发 ' + formatAge(now - trigger.lastAt) + '（共 ' + (trigger.count || 0) + ' 次）');
  }
  const warnings = loaded.warnings.concat(store.problems.map((p) => '存储 ' + p.key.replace('BiliCDNPicker.', '') + ' ' + p.problem));
  if (warnings.length) lines.push('⚠︎ ' + warnings.slice(0, 2).join('；'));

  let style = 'info';
  const decided = Object.keys(decisions.items).some((k) => decisions.items[k].networkKey === net.key && decisions.items[k].expiresAt > now);
  if (!config.enabled || control.paused) style = 'alert';
  else if (warnings.length) style = 'alert';
  else if (decided) style = 'good';
  return { title, content: lines.join('\n'), style };
}

function sumBudgets(resources) {
  if (!resources.length) return null;
  const out = { observedBytes: 0, unobservableBytes: 0, unobservableCount: 0, overrunCount: 0 };
  resources.forEach((r) => {
    const b = r.budget || {};
    out.observedBytes += b.observedBytes || 0;
    out.unobservableBytes += b.unobservableBytes || 0;
    out.unobservableCount += b.unobservableCount || 0;
    out.overrunCount += b.overrunCount || 0;
  });
  return out;
}

// ctx: runner ctx plus {trigger, panelAction}
async function panelMain(ctx) {
  const panelAction = normalizeAction(ctx.panelAction, 'quick');
  const title = panelAction === 'full' ? 'B站 CDN · 完整探索' : panelAction === 'stop' ? 'B站 CDN · 停止测速' : 'B站 CDN';
  let result = null;
  if (['button', 'editor', 'intent'].includes(ctx.trigger) && panelAction !== 'status') {
    const { runAction } = require('./runner');
    result = await runAction(Object.assign({}, ctx, { action: panelAction }));
  }
  return render(ctx, result, title);
}

module.exports = { panelMain, render, statusText };
