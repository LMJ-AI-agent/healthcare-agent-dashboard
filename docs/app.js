const GOALS = {
  weightKg: 79,
  steps: 8000,
  sleepHours: 6.5,
  activeEnergyKcal: 650,
  bodyFatPercent: 25,
};

const metrics = {
  weightKg: { label: '体重', color: '#3567e8', format: v => v == null ? '-' : v.toFixed(1) + 'kg' },
  bodyFatPercent: { label: '体脂肪率', color: '#df4b4b', format: v => v == null ? '-' : v.toFixed(1) + '%' },
  sleepHours: { label: '睡眠', color: '#7c5cff', format: v => v == null ? '-' : hours(v) },
  steps: { label: '歩数', color: '#15956b', format: v => v == null ? '-' : Math.round(v).toLocaleString('ja-JP') + '歩' },
  activeEnergyKcal: { label: '活動kcal', color: '#f29f3d', format: v => v == null ? '-' : Math.round(v) + 'kcal' },
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
  const m = latest?.metrics || {};
  const kgLeft = m.weightKg == null ? null : m.weightKg - GOALS.weightKg;
  document.getElementById('heroLead').textContent =
    data.generatedAt
      ? '更新: ' + new Date(data.generatedAt).toLocaleString('ja-JP') + ' / ' + data.recordCount + '日分。体重を落とすだけでなく、睡眠・活動量・筋トレで仕事のパフォーマンスが出る体を作る。'
      : '';
  renderHeroMetrics(latest, kgLeft);
  renderCoaching(latest);
  renderRadar(latest);
  renderKpis(latest);
  renderStrengthPlan(latest);
  renderDietPlan(latest);
  renderTabs();
  renderChart();
  renderWeightGoal(latest);
  renderStatus();
  renderTable();
}

function renderHeroMetrics(record, kgLeft) {
  const m = record?.metrics || {};
  const seven = record?.coaching?.sevenDay || {};
  const cards = [
    ['現在体重', metrics.weightKg.format(m.weightKg), kgLeft == null ? '目標79.0kg' : '残り' + kgLeft.toFixed(1) + 'kg'],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), seven.bodyFatPercent == null ? '7日平均なし' : '7日平均 ' + seven.bodyFatPercent.toFixed(1) + '%'],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), seven.sleepHours == null ? '7日平均なし' : '7日平均 ' + hours(seven.sleepHours)],
    ['歩数', metrics.steps.format(m.steps), '目標 ' + GOALS.steps.toLocaleString('ja-JP') + '歩'],
  ];
  document.getElementById('heroMetrics').innerHTML = cards.map(([label, value, sub]) =>
    '<div class="hero-card"><span>' + label + '</span><strong>' + value + '</strong><small>' + sub + '</small></div>'
  ).join('');
}

function renderCoaching(record) {
  document.getElementById('topPriority').textContent = record?.coaching?.topPriority || 'データ確認';
  const titles = ['活動量', '筋トレ', '食事', '減量ペース'];
  const actions = record?.coaching?.actions?.length ? record.coaching.actions : ['体重・睡眠・歩数のデータ取得状態を確認する。'];
  document.getElementById('coachActions').innerHTML = '<div class="action-list">' + actions.map((text, i) => (
    '<div class="action-item"><span class="action-no">' + String(i + 1).padStart(2, '0') + '</span><div><strong>' + titles[i % titles.length] + '</strong><p>' + escapeHtml(text) + '</p></div></div>'
  )).join('') + '</div>';
}

function renderRadar(record) {
  const scores = buildScores(record);
  const labels = scores.map(s => s.label);
  const values = scores.map(s => s.score);
  const cx = 150;
  const cy = 150;
  const maxR = 104;
  const points = values.map((score, i) => point(cx, cy, maxR * score / 100, i, values.length));
  const grid = [20,40,60,80,100].map(level => {
    const poly = values.map((_, i) => point(cx, cy, maxR * level / 100, i, values.length)).map(p => p.join(',')).join(' ');
    return '<polygon points="' + poly + '" fill="none" stroke="#dfe6df" stroke-width="1"/>';
  }).join('');
  const axis = labels.map((label, i) => {
    const end = point(cx, cy, maxR, i, labels.length);
    const text = point(cx, cy, maxR + 22, i, labels.length);
    return '<line x1="' + cx + '" y1="' + cy + '" x2="' + end[0] + '" y2="' + end[1] + '" stroke="#dfe6df"/><text x="' + text[0] + '" y="' + text[1] + '" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#66736d">' + label + '</text>';
  }).join('');
  const polygon = points.map(p => p.join(',')).join(' ');
  document.getElementById('radar').innerHTML =
    '<div class="radar-layout"><svg viewBox="0 0 300 300" role="img" aria-label="5角形パラメータ">' +
    grid + axis +
    '<polygon points="' + polygon + '" fill="rgba(21,149,107,.24)" stroke="#15956b" stroke-width="3"/>' +
    points.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#12261f"/>').join('') +
    '</svg><div class="score-list">' +
    scores.map(s => '<div class="score-row"><span>' + s.label + '</span><div class="mini-bar"><span style="width:' + s.score + '%"></span></div><strong>' + s.score + '</strong></div>').join('') +
    '</div></div>';
}

function buildScores(record) {
  const m = record?.metrics || {};
  return [
    { label: '減量', score: clamp(100 - Math.max(0, (m.weightKg ?? 84) - GOALS.weightKg) * 12, 0, 100) },
    { label: '活動', score: clamp(((m.steps ?? 0) / GOALS.steps) * 100, 0, 100) },
    { label: '睡眠', score: clamp(((m.sleepHours ?? 0) / GOALS.sleepHours) * 100, 0, 100) },
    { label: '体脂肪', score: clamp(100 - Math.max(0, (m.bodyFatPercent ?? 32) - GOALS.bodyFatPercent) * 9, 0, 100) },
    { label: '筋トレ', score: estimateStrengthScore(record) },
  ].map(s => ({ ...s, score: Math.round(s.score) }));
}

function estimateStrengthScore(record) {
  const m = record?.metrics || {};
  let score = 45;
  if ((m.steps ?? 0) >= GOALS.steps) score += 18;
  if ((m.sleepHours ?? 0) >= 6) score += 18;
  if ((m.activeEnergyKcal ?? 0) >= GOALS.activeEnergyKcal) score += 12;
  if ((m.bodyFatPercent ?? 99) <= 28) score += 7;
  return clamp(score, 0, 100);
}

function renderKpis(record) {
  const m = record?.metrics || {};
  const c = record?.coaching || {};
  const items = [
    ['体重', metrics.weightKg.format(m.weightKg), goalText(m.weightKg, GOALS.weightKg, 'kg')],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), deltaText(c.deltas?.bodyFatPercent, '%')],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), deltaText(c.deltas?.sleepHours, 'h')],
    ['歩数', metrics.steps.format(m.steps), targetText(m.steps, GOALS.steps, '歩')],
    ['活動量', metrics.activeEnergyKcal.format(m.activeEnergyKcal), targetText(m.activeEnergyKcal, GOALS.activeEnergyKcal, 'kcal')],
  ];
  document.getElementById('kpis').innerHTML = items.map(([label, value, sub]) =>
    '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + sub + '</div></div>'
  ).join('');
}

function renderStrengthPlan(record) {
  const m = record?.metrics || {};
  const tired = m.sleepHours == null || m.sleepHours < 6;
  const plans = tired
    ? [
        ['回復日メニュー', '12分', ['スクワット 10回 x 2', '壁腕立て 10回 x 2', 'プランク 20秒 x 2']],
        ['目的', '疲労を残さない', ['フォーム確認だけ行う', '息が上がりすぎる運動は避ける']],
      ]
    : [
        ['下半身', '20分', ['スクワット 10回 x 3', 'ヒップヒンジ 12回 x 3', 'カーフレイズ 15回 x 2']],
        ['上半身', '18分', ['腕立て 8回 x 3', 'ローイング 12回 x 3', 'ショルダープレス 10回 x 2']],
        ['体幹', '8分', ['プランク 30秒 x 3', 'デッドバグ 左右10回 x 2']],
      ];
  document.getElementById('strengthPlan').innerHTML = '<div class="plan-stack">' + plans.map(([title, tag, items]) =>
    '<div class="plan-card"><div class="top"><h3>' + title + '</h3><span class="tag">' + tag + '</span></div><ul>' + items.map(item => '<li>' + item + '</li>').join('') + '</ul></div>'
  ).join('') + '</div>';
}

function renderDietPlan(record) {
  const m = record?.metrics || {};
  const rules = [
    ['朝', 'たんぱく質を先に入れる。卵・ヨーグルト・鶏肉・魚のどれかを選ぶ。'],
    ['昼', '主食はゼロにしない。量を固定して、揚げ物と甘い飲み物を避ける。'],
    ['夜', '遅い時間は脂質を軽くする。米を減らすより、間食を先に削る。'],
    ['今日の調整', m.steps == null ? '歩数が未取得なので、食事は守り寄り。夜の間食はなし。' : m.steps < GOALS.steps ? '歩数が少ない日は食事で取り返す。夜の間食はなし。' : '活動量がある日は無理な食事制限をしない。たんぱく質を優先。'],
  ];
  document.getElementById('dietPlan').innerHTML = '<div class="plan-stack">' + rules.map(([title, text]) =>
    '<div class="plan-card"><div class="top"><h3>' + title + '</h3></div><ul><li>' + text + '</li></ul></div>'
  ).join('') + '</div>';
}

function renderTabs() {
  document.getElementById('metricTabs').innerHTML = Object.entries(metrics).map(([key, meta]) =>
    '<button class="tab ' + (key === selectedMetric ? 'active' : '') + '" data-key="' + key + '">' + meta.label + '</button>'
  ).join('');
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
  const width = 940;
  const height = 310;
  const left = 56;
  const right = 20;
  const top = 22;
  const bottom = 44;
  const x = i => left + i * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = v => top + (hi - v) * ((height - top - bottom) / Math.max(1, hi - lo));
  const points = rows.map((r, i) => [x(i), y(r.metrics[selectedMetric]), r]);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = path + ' L' + points.at(-1)[0].toFixed(1) + ',' + (height - bottom) + ' L' + points[0][0].toFixed(1) + ',' + (height - bottom) + ' Z';
  const labels = rows.map((r, i) => i % Math.ceil(rows.length / 8) === 0 || i === rows.length - 1
    ? '<text x="' + x(i) + '" y="' + (height - 13) + '" text-anchor="middle" font-size="11" fill="#66736d">' + r.date.slice(5) + '</text>'
    : '').join('');
  chart.innerHTML =
    '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + meta.label + ' chart">' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<line x1="' + left + '" y1="' + (height - bottom) + '" x2="' + (width - right) + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<path d="' + area + '" fill="' + meta.color + '" opacity=".11"/>' +
    '<path d="' + path + '" fill="none" stroke="' + meta.color + '" stroke-width="3.5"/>' +
    points.map(([cx, cy, r]) => '<circle cx="' + cx + '" cy="' + cy + '" r="4.5" fill="#fff" stroke="' + meta.color + '" stroke-width="3"><title>' + r.date + ': ' + meta.format(r.metrics[selectedMetric]) + '</title></circle>').join('') +
    '<text x="8" y="' + (top + 6) + '" font-size="11" fill="#66736d">' + meta.format(max) + '</text>' +
    '<text x="8" y="' + (height - bottom) + '" font-size="11" fill="#66736d">' + meta.format(min) + '</text>' +
    labels +
    '</svg>';
}

function renderWeightGoal(record) {
  const weight = record?.metrics?.weightKg;
  const target = record?.goal?.weightTargetKg || GOALS.weightKg;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / Math.max(.1, start - target)) * 100));
  document.getElementById('weightGoal').innerHTML =
    '<div class="status-list">' +
    '<div class="status-item"><span>現在</span><strong>' + metrics.weightKg.format(weight) + '</strong></div>' +
    '<div class="status-item"><span>目標</span><strong>' + target.toFixed(1) + 'kg</strong></div>' +
    '<div class="status-item"><span>残り</span><strong>' + (weight == null ? '-' : (weight - target).toFixed(1) + 'kg') + '</strong></div>' +
    '<div class="status-item"><span>推奨ペース</span><strong>2週間で1kg減</strong></div>' +
    '<div class="progress"><span style="width:' + progress + '%"></span></div>' +
    '</div>';
}

function renderStatus() {
  const total = records.length;
  const generated = records.filter(r => r.status === 'posted_or_generated').length;
  const notReady = records.filter(r => r.status === 'not_ready').length;
  const bodyOnly = records.filter(r => r.status === 'body_only').length;
  document.getElementById('dataStatus').innerHTML =
    '<div class="status-list">' +
    '<div class="status-item"><span>対象日数</span><strong>' + total + '</strong></div>' +
    '<div class="status-item"><span>レポート生成済み</span><strong class="ok">' + generated + '</strong></div>' +
    '<div class="status-item"><span>準備不足</span><strong class="warn">' + notReady + '</strong></div>' +
    '<div class="status-item"><span>体組成のみ</span><strong>' + bodyOnly + '</strong></div>' +
    '<div class="status-item"><span>筋トレ実績</span><strong class="warn">未連携</strong></div>' +
    '</div>';
}

function renderTable() {
  document.getElementById('dailyRows').innerHTML = [...records].reverse().map(r =>
    '<tr>' +
    '<td>' + r.date + '</td>' +
    '<td>' + statusLabel(r.status) + '</td>' +
    '<td>' + metrics.sleepHours.format(r.metrics.sleepHours) + '</td>' +
    '<td>' + metrics.steps.format(r.metrics.steps) + '</td>' +
    '<td>' + metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal) + '</td>' +
    '<td>' + metrics.weightKg.format(r.metrics.weightKg) + '</td>' +
    '<td>' + metrics.bodyFatPercent.format(r.metrics.bodyFatPercent) + '</td>' +
    '<td>' + (r.metrics.bodyMassIndex == null ? '-' : r.metrics.bodyMassIndex.toFixed(1)) + '</td>' +
    '</tr>'
  ).join('');
}

function point(cx, cy, r, index, total) {
  const angle = -Math.PI / 2 + index * 2 * Math.PI / total;
  return [Math.round((cx + Math.cos(angle) * r) * 10) / 10, Math.round((cy + Math.sin(angle) * r) * 10) / 10];
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}