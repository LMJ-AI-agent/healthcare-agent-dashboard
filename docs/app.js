const GOALS = {
  weightKg: 79,
  steps: 8000,
  sleepHours: 6.5,
  strengthSessions: 3,
};

const metrics = {
  weightKg: { label: '体重', unit: 'kg', color: '#2563eb', format: v => v == null ? '-' : v.toFixed(1) + 'kg' },
  bodyFatPercent: { label: '体脂肪率', unit: '%', color: '#dc2626', format: v => v == null ? '-' : v.toFixed(1) + '%' },
  sleepHours: { label: '睡眠', unit: 'h', color: '#7c3aed', format: v => v == null ? '-' : hours(v) },
  steps: { label: '歩数', unit: '歩', color: '#0f9f6e', format: v => v == null ? '-' : Math.round(v).toLocaleString('ja-JP') + '歩' },
  activeEnergyKcal: { label: '活動kcal', unit: 'kcal', color: '#f59e0b', format: v => v == null ? '-' : Math.round(v) + 'kcal' },
};

let records = [];
let selectedMetric = 'weightKg';

fetch('./health-data.json')
  .then(res => res.json())
  .then(data => {
    records = data.records || [];
    render(data);
  });

function render(data) {
  const latest = [...records].reverse().find(r => hasAnyMetric(r)) || records.at(-1);
  document.getElementById('summary').textContent = data.generatedAt
    ? '更新: ' + new Date(data.generatedAt).toLocaleString('ja-JP') + ' / ' + data.recordCount + '日分'
    : '';
  renderCoaching(latest);
  renderWeeklyPlan(latest);
  renderKpis(latest);
  renderTabs();
  renderChart();
  renderWeightGoal(latest);
  renderStrengthPlan();
  renderStatus();
  renderTable();
}

function renderCoaching(record) {
  document.getElementById('coachFocus').textContent = record?.coaching?.focus || 'データ確認';
  const actions = record?.coaching?.actions?.length ? record.coaching.actions : ['今日のデータが不足しています。まず体重・睡眠・歩数の取得状態を確認'];
  document.getElementById('coachActions').innerHTML = '<div class="action-list">' + actions.map((text, i) => (
    '<div class="action-item"><span class="icon">' + ['●', '✓', '+'][i % 3] + '</span><div>' + escapeHtml(text) + '</div></div>'
  )).join('') + '</div>';
}

function renderWeeklyPlan(record) {
  const seven = record?.coaching?.sevenDay || {};
  const items = [
    ['7日平均歩数', formatNumber(seven.steps, '歩'), GOALS.steps.toLocaleString('ja-JP') + '歩を基準にする'],
    ['7日平均睡眠', metrics.sleepHours.format(seven.sleepHours), '6時間30分以上で減量の土台を守る'],
    ['7日平均活動', formatNumber(seven.activeEnergyKcal, 'kcal'), '少なすぎる日は短い散歩で補う'],
    ['筋トレ', '週3回', '下半身・押す・引く/体幹を1回ずつ'],
  ];
  document.getElementById('weeklyPlan').innerHTML = '<div class="plan-list">' + items.map(([label, value, note]) => (
    '<div class="plan-item"><span>' + label + '</span><strong>' + value + '</strong></div><div class="sub">' + note + '</div>'
  )).join('') + '</div>';
}

function renderKpis(record) {
  const m = record?.metrics || {};
  const c = record?.coaching || {};
  const items = [
    ['体重', metrics.weightKg.format(m.weightKg), goalText(m.weightKg, GOALS.weightKg, 'kg')],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), deltaText(c.deltas?.bodyFatPercent, '%')],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), deltaText(c.deltas?.sleepHours, 'h')],
    ['歩数', metrics.steps.format(m.steps), targetText(m.steps, GOALS.steps, '歩')],
    ['活動量', metrics.activeEnergyKcal.format(m.activeEnergyKcal), deltaText(c.deltas?.activeEnergyKcal, 'kcal')],
    ['BMI', m.bodyMassIndex == null ? '-' : m.bodyMassIndex.toFixed(1), '身長162cm換算の体重管理に使用'],
  ];
  document.getElementById('kpis').innerHTML = items.map(([label, value, sub]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>
  `).join('');
}

function renderTabs() {
  document.getElementById('metricTabs').innerHTML = Object.entries(metrics).map(([key, meta]) => `
    <button class="tab ${key === selectedMetric ? 'active' : ''}" data-key="${key}">${meta.label}</button>
  `).join('');
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedMetric = btn.dataset.key;
      renderTabs();
      renderChart();
    });
  });
}

function renderChart() {
  const meta = metrics[selectedMetric];
  const rows = records.filter(r => r.metrics?.[selectedMetric] != null);
  const values = rows.map(r => r.metrics[selectedMetric]);
  const chart = document.getElementById('chart');
  if (!values.length) {
    chart.innerHTML = '<p class="bad">この項目のデータがありません</p>';
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max === min ? 1 : (max - min) * 0.15;
  const lo = min - pad;
  const hi = max + pad;
  const width = 900;
  const height = 280;
  const left = 54;
  const right = 18;
  const top = 20;
  const bottom = 42;
  const x = i => left + i * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = v => top + (hi - v) * ((height - top - bottom) / Math.max(1, hi - lo));
  const points = rows.map((r, i) => [x(i), y(r.metrics[selectedMetric]), r]);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const labels = rows.map((r, i) => i % Math.ceil(rows.length / 8) === 0 || i === rows.length - 1
    ? `<text x="${x(i)}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#647084">${r.date.slice(5)}</text>`
    : '').join('');
  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${meta.label} chart">
      <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" stroke="#dce2ea"/>
      <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#dce2ea"/>
      <text x="8" y="${top + 6}" font-size="11" fill="#647084">${meta.format(max)}</text>
      <text x="8" y="${height - bottom}" font-size="11" fill="#647084">${meta.format(min)}</text>
      <path d="${path}" fill="none" stroke="${meta.color}" stroke-width="3"/>
      ${points.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="4" fill="${meta.color}"><title>${r.date}: ${meta.format(r.metrics[selectedMetric])}</title></circle>`).join('')}
      ${labels}
    </svg>
  `;
}

function renderWeightGoal(record) {
  const weight = record?.metrics?.weightKg;
  const target = record?.goal?.weightTargetKg || GOALS.weightKg;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / Math.max(.1, start - target)) * 100));
  document.getElementById('weightGoal').innerHTML = `
    <div class="status-list">
      <div class="status-item"><span>現在</span><strong>${metrics.weightKg.format(weight)}</strong></div>
      <div class="status-item"><span>目標</span><strong>${target.toFixed(1)}kg</strong></div>
      <div class="status-item"><span>残り</span><strong>${weight == null ? '-' : (weight - target).toFixed(1) + 'kg'}</strong></div>
      <div class="status-item"><span>推奨ペース</span><strong>2週間で1kg減</strong></div>
      <div class="progress"><span style="width:${progress}%"></span></div>
    </div>
  `;
}

function renderStrengthPlan() {
  const items = [
    ['下半身', 'スクワット系 3セット + ヒップヒンジ 3セット'],
    ['押す', '腕立て/チェストプレス 3セット + 肩 2セット'],
    ['引く・体幹', 'ローイング 3セット + プランク 2セット'],
    ['ルール', '筋肉痛が強い日は散歩とストレッチに変更'],
  ];
  document.getElementById('strengthPlan').innerHTML = '<div class="status-list">' + items.map(([label, value]) => (
    '<div class="status-item"><span>' + label + '</span><strong>' + value + '</strong></div>'
  )).join('') + '<p class="sub">筋トレ実績データは未連携のため、現時点では計画として表示しています。</p></div>';
}

function renderStatus() {
  const total = records.length;
  const generated = records.filter(r => r.status === 'posted_or_generated').length;
  const notReady = records.filter(r => r.status === 'not_ready').length;
  const bodyOnly = records.filter(r => r.status === 'body_only').length;
  document.getElementById('dataStatus').innerHTML = `
    <div class="status-list">
      <div class="status-item"><span>対象日数</span><strong>${total}</strong></div>
      <div class="status-item"><span>レポート生成済み</span><strong class="ok">${generated}</strong></div>
      <div class="status-item"><span>準備不足</span><strong class="warn">${notReady}</strong></div>
      <div class="status-item"><span>体組成のみ</span><strong>${bodyOnly}</strong></div>
      <div class="status-item"><span>筋トレ実績</span><strong class="warn">未連携</strong></div>
    </div>
  `;
}

function renderTable() {
  document.getElementById('dailyRows').innerHTML = [...records].reverse().map(r => `
    <tr>
      <td>${r.date}</td>
      <td>${statusLabel(r.status)}</td>
      <td>${metrics.sleepHours.format(r.metrics.sleepHours)}</td>
      <td>${metrics.steps.format(r.metrics.steps)}</td>
      <td>${metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal)}</td>
      <td>${metrics.weightKg.format(r.metrics.weightKg)}</td>
      <td>${metrics.bodyFatPercent.format(r.metrics.bodyFatPercent)}</td>
      <td>${r.metrics.bodyMassIndex == null ? '-' : r.metrics.bodyMassIndex.toFixed(1)}</td>
      <td>${(r.missing || []).join(', ') || '-'}</td>
    </tr>
  `).join('');
}

function goalText(value, target, unit) {
  if (value == null) return '目標 ' + target + unit;
  const diff = value - target;
  return diff <= 0 ? '目標達成' : '目標まであと' + diff.toFixed(1) + unit;
}

function targetText(value, target, unit) {
  if (value == null) return '目標 ' + target.toLocaleString('ja-JP') + unit;
  const diff = value - target;
  return diff >= 0 ? '目標比 +' + Math.round(diff).toLocaleString('ja-JP') + unit : '目標まで ' + Math.abs(Math.round(diff)).toLocaleString('ja-JP') + unit;
}

function deltaText(value, unit) {
  if (value == null) return '前回比データなし';
  const sign = value > 0 ? '+' : '';
  if (unit === 'h') return '前回比 ' + sign + value.toFixed(2) + '時間';
  return '前回比 ' + sign + value.toFixed(unit === '%' ? 1 : 0) + unit;
}

function formatNumber(value, unit) {
  return value == null ? '-' : Math.round(value).toLocaleString('ja-JP') + unit;
}

function statusLabel(status) {
  if (status === 'posted_or_generated') return '<span class="ok">生成済み</span>';
  if (status === 'not_ready') return '<span class="warn">準備不足</span>';
  if (status === 'body_only') return '体組成のみ';
  return '-';
}

function hasAnyMetric(record) {
  return record && Object.values(record.metrics || {}).some(v => v != null);
}

function hours(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const mins = Math.round(Number(value) * 60);
  return Math.floor(mins / 60) + '時間' + String(mins % 60).padStart(2, '0') + '分';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}