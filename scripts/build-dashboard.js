import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const reportsDir = join(root, 'data', 'reports');
const healthPlanetDir = join(root, 'data', 'healthplanet');
const outputDir = join(root, 'docs');

const DEFAULT_WEIGHT_TARGET_KG = 79;
const STEP_TARGET = 8000;
const SLEEP_TARGET_HOURS = 6.5;
const STRENGTH_TARGET_PER_WEEK = 3;

async function main() {
  const records = await buildRecords();
  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, 'health-data.json'), {
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    goals: {
      weightTargetKg: DEFAULT_WEIGHT_TARGET_KG,
      dailySteps: STEP_TARGET,
      sleepHours: SLEEP_TARGET_HOURS,
      strengthSessionsPerWeek: STRENGTH_TARGET_PER_WEEK,
    },
    records,
  });
  await writeFile(join(outputDir, 'index.html'), dashboardHtml(), 'utf8');
  await writeFile(join(outputDir, 'styles.css'), dashboardCss(), 'utf8');
  await writeFile(join(outputDir, 'app.js'), dashboardJs(), 'utf8');
  console.log(`Dashboard built: ${join(outputDir, 'index.html')}`);
  console.log(`Records: ${records.length}`);
}

async function buildRecords() {
  const reportDates = await listDirectoriesSafe(reportsDir);
  const healthPlanetDates = (await listFilesSafe(healthPlanetDir))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10));
  const dates = [...new Set([...reportDates, ...healthPlanetDates])].sort();
  const records = [];

  for (const date of dates) {
    const input = await readJsonIfExists(join(reportsDir, date, 'input-summary.json'));
    const latestSkip = await readLatestReadinessSkip(date);
    const healthPlanet = await readJsonIfExists(join(healthPlanetDir, `${date}.json`));
    records.push(normalizeRecord({ date, input, latestSkip, healthPlanet }));
  }

  return withCoaching(records);
}

function normalizeRecord({ date, input, latestSkip, healthPlanet }) {
  const target = input?.trendSummary?.target || {};
  const avg7 = input?.trendSummary?.currentSevenDayAverage || {};
  const diff7 = input?.trendSummary?.differenceFromCurrentSevenDayAverage || {};
  const goals = input?.trendSummary?.goals || {};
  const readiness = input?.readiness || latestSkip?.readiness || null;
  const hp = input?.healthPlanet?.normalized || latestSkip?.healthPlanet?.normalized || healthPlanet?.normalized || null;
  const status = input ? 'posted_or_generated' : latestSkip ? 'not_ready' : hp ? 'body_only' : 'unknown';

  return {
    date,
    status,
    bodyCompositionDate: input?.bodyCompositionDate || latestSkip?.bodyCompositionDate || hp?.measuredDate || null,
    readiness,
    missing: readiness?.missing || [],
    metrics: {
      sleepHours: numberOrNull(target.sleepHours ?? latestSkip?.sleepSummary?.totalSleepHours),
      steps: numberOrNull(target.steps),
      activeEnergyKcal: numberOrNull(target.activeEnergyKcal),
      weightKg: numberOrNull(target.weightKg ?? hp?.weightKg),
      bodyMassIndex: numberOrNull(target.bodyMassIndex ?? hp?.bodyMassIndex),
      bodyFatPercent: numberOrNull(target.bodyFatPercent ?? hp?.bodyFatPercent),
    },
    average7: {
      sleepHours: numberOrNull(avg7.sleepHours),
      steps: numberOrNull(avg7.steps),
      activeEnergyKcal: numberOrNull(avg7.activeEnergyKcal),
      weightKg: numberOrNull(avg7.weightKg),
      bodyFatPercent: numberOrNull(avg7.bodyFatPercent),
    },
    diffFromAverage7: {
      sleepHours: numberOrNull(diff7.sleepHours),
      steps: numberOrNull(diff7.steps),
      activeEnergyKcal: numberOrNull(diff7.activeEnergyKcal),
      weightKg: numberOrNull(diff7.weightKg),
      bodyFatPercent: numberOrNull(diff7.bodyFatPercent),
    },
    goal: {
      weightTargetKg: numberOrNull(goals.weightTargetKgByJuneEnd ?? DEFAULT_WEIGHT_TARGET_KG),
      kgToTarget: numberOrNull(goals.kgToTarget),
    },
    files: {
      healthFile: input?.healthFile?.path || latestSkip?.healthFile || null,
      sleepFile: input?.sleepFile?.path || latestSkip?.sleepFile || null,
      healthPlanetFile: input?.healthPlanet?.path || latestSkip?.healthPlanet?.path || (healthPlanet ? `data/healthplanet/${date}.json` : null),
    },
  };
}

function withCoaching(records) {
  return records.map((record, index) => {
    const previous = findPreviousWithMetrics(records, index);
    const latest7 = records.slice(Math.max(0, index - 6), index + 1);
    return {
      ...record,
      coaching: buildCoaching(record, previous, latest7),
    };
  });
}

function findPreviousWithMetrics(records, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (hasAnyMetric(records[i])) return records[i];
  }
  return null;
}

function buildCoaching(record, previous, latest7) {
  const m = record.metrics;
  const prev = previous?.metrics || {};
  const weightTarget = record.goal.weightTargetKg || DEFAULT_WEIGHT_TARGET_KG;
  const kgToTarget = m.weightKg == null ? null : round1(m.weightKg - weightTarget);
  const sleepAvg7 = average(latest7.map((r) => r.metrics.sleepHours));
  const stepsAvg7 = average(latest7.map((r) => r.metrics.steps));
  const kcalAvg7 = average(latest7.map((r) => r.metrics.activeEnergyKcal));
  const weightDelta = delta(m.weightKg, prev.weightKg);
  const bodyFatDelta = delta(m.bodyFatPercent, prev.bodyFatPercent);

  const actions = [];
  if (m.sleepHours != null && m.sleepHours < 6) {
    actions.push('今日は強度を上げすぎず、歩数と食事の安定を優先');
  } else if (m.steps != null && m.steps < STEP_TARGET) {
    actions.push(`歩数は${STEP_TARGET.toLocaleString('ja-JP')}歩を目安に、昼か夕方に10分歩く`);
  } else {
    actions.push('活動量は維持。食事量を崩さず、回復を削らない');
  }

  if (m.bodyFatPercent != null && m.bodyFatPercent >= 28) {
    actions.push('筋トレは下半身・背中・体幹を優先し、体脂肪を落としやすい土台を作る');
  } else {
    actions.push('筋トレは週3回ペースを維持し、重量か回数を少しずつ伸ばす');
  }

  if (kgToTarget != null && kgToTarget > 0) {
    actions.push(`79.0kgまであと${kgToTarget.toFixed(1)}kg。急がず、2週間で1kg減のペースを守る`);
  }

  const focus =
    m.sleepHours != null && m.sleepHours < 6
      ? '回復優先'
      : m.steps != null && m.steps < STEP_TARGET
        ? '活動量を戻す日'
        : '減量を進める日';

  return {
    focus,
    actions,
    deltas: {
      weightKg: weightDelta,
      bodyFatPercent: bodyFatDelta,
      sleepHours: delta(m.sleepHours, prev.sleepHours),
      steps: delta(m.steps, prev.steps),
      activeEnergyKcal: delta(m.activeEnergyKcal, prev.activeEnergyKcal),
    },
    sevenDay: {
      sleepHours: round2(sleepAvg7),
      steps: stepsAvg7 == null ? null : Math.round(stepsAvg7),
      activeEnergyKcal: kcalAvg7 == null ? null : Math.round(kcalAvg7),
      weightKg: round2(average(latest7.map((r) => r.metrics.weightKg))),
      bodyFatPercent: round2(average(latest7.map((r) => r.metrics.bodyFatPercent))),
    },
  };
}

async function readLatestReadinessSkip(date) {
  const dir = join(reportsDir, date);
  const files = (await listFilesSafe(dir))
    .filter((name) => /^readiness-skip-.+\.json$/.test(name))
    .sort();
  const latest = files.at(-1);
  return latest ? readJsonIfExists(join(dir, latest)) : null;
}

async function listDirectoriesSafe(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listFilesSafe(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function numberOrNull(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function average(values) {
  const nums = values.filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function delta(current, previous) {
  return current == null || previous == null ? null : round2(Number(current) - Number(previous));
}

function round1(value) {
  return value == null ? null : Math.round(Number(value) * 10) / 10;
}

function round2(value) {
  return value == null ? null : Math.round(Number(value) * 100) / 100;
}

function hasAnyMetric(record) {
  return record && Object.values(record.metrics || {}).some((value) => value != null);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Diet Coach Dashboard</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">Healthcare Agent</p>
      <h1>Diet Coach Dashboard</h1>
    </div>
    <div class="summary" id="summary"></div>
  </header>

  <main>
    <section class="coach-grid">
      <section class="panel coach-panel">
        <div class="panel-head">
          <h2>今日のコーチング</h2>
          <span class="pill" id="coachFocus"></span>
        </div>
        <div id="coachActions"></div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>今週の作戦</h2>
        </div>
        <div id="weeklyPlan"></div>
      </section>
    </section>

    <section class="kpis" id="kpis"></section>

    <section class="panel">
      <div class="panel-head">
        <h2>推移グラフ</h2>
        <div class="tabs" id="metricTabs"></div>
      </div>
      <div class="chart" id="chart"></div>
    </section>

    <section class="grid">
      <div class="panel">
        <div class="panel-head">
          <h2>79kg目標</h2>
        </div>
        <div id="weightGoal"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>筋トレプラン</h2>
        </div>
        <div id="strengthPlan"></div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>データ状態</h2>
      </div>
      <div id="dataStatus"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>日別データ</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日付</th>
              <th>状態</th>
              <th>睡眠</th>
              <th>歩数</th>
              <th>活動kcal</th>
              <th>体重</th>
              <th>体脂肪</th>
              <th>BMI</th>
              <th>不足</th>
            </tr>
          </thead>
          <tbody id="dailyRows"></tbody>
        </table>
      </div>
    </section>
  </main>

  <script src="./app.js"></script>
</body>
</html>`;
}

function dashboardCss() {
  return `:root {
  color-scheme: light;
  --bg: #f5f6f8;
  --panel: #ffffff;
  --text: #1d2430;
  --muted: #647084;
  --line: #dce2ea;
  --blue: #2563eb;
  --green: #0f9f6e;
  --orange: #f59e0b;
  --red: #dc2626;
  --ink: #111827;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
.topbar {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-end;
  padding: 28px 32px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 13px;
  letter-spacing: .04em;
}
h1, h2 { margin: 0; }
h1 { font-size: 28px; }
h2 { font-size: 17px; }
main {
  max-width: 1180px;
  margin: 0 auto;
  padding: 22px;
}
.summary {
  color: var(--muted);
  font-size: 14px;
  text-align: right;
}
.coach-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, .65fr);
  gap: 14px;
  margin-bottom: 14px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.kpi, .panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.kpi {
  padding: 14px;
}
.kpi .label {
  color: var(--muted);
  font-size: 13px;
}
.kpi .value {
  margin-top: 8px;
  font-size: 24px;
  font-weight: 700;
}
.kpi .sub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
}
.panel {
  padding: 16px;
  margin-bottom: 14px;
}
.coach-panel {
  border-left: 5px solid var(--green);
}
.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  margin-bottom: 14px;
}
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 5px 10px;
  border-radius: 999px;
  color: #065f46;
  background: #d9f7ea;
  font-size: 13px;
  font-weight: 700;
}
.action-list, .status-list, .plan-list {
  display: grid;
  gap: 9px;
}
.action-item {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 9px;
  align-items: start;
  line-height: 1.55;
}
.icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: inline-grid;
  place-items: center;
  background: #eef2ff;
  font-size: 14px;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tab {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 6px;
  padding: 7px 10px;
  cursor: pointer;
}
.tab.active {
  color: #fff;
  border-color: var(--blue);
  background: var(--blue);
}
.chart {
  min-height: 280px;
}
.chart svg {
  width: 100%;
  height: 300px;
  display: block;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.progress {
  height: 12px;
  border-radius: 999px;
  background: #edf1f6;
  overflow: hidden;
}
.progress span {
  display: block;
  height: 100%;
  background: var(--green);
}
.status-item, .plan-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}
.status-item span, .plan-item span {
  color: var(--muted);
}
.ok { color: var(--green); }
.warn { color: var(--orange); }
.bad { color: var(--red); }
.table-wrap { overflow-x: auto; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th, td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--line);
  text-align: right;
  white-space: nowrap;
}
th:first-child, td:first-child,
th:nth-child(2), td:nth-child(2),
th:last-child, td:last-child {
  text-align: left;
}
@media (max-width: 1020px) {
  .coach-grid, .grid { grid-template-columns: 1fr; }
  .kpis { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
}
@media (max-width: 720px) {
  .topbar { display: block; padding: 22px 18px 14px; }
  .summary { text-align: left; margin-top: 10px; }
  main { padding: 14px; }
  .kpis { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
  .panel-head { align-items: flex-start; flex-direction: column; }
}`;
}

function dashboardJs() {
  return `const GOALS = {
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
  document.getElementById('kpis').innerHTML = items.map(([label, value, sub]) => \`
    <div class="kpi">
      <div class="label">\${label}</div>
      <div class="value">\${value}</div>
      <div class="sub">\${sub}</div>
    </div>
  \`).join('');
}

function renderTabs() {
  document.getElementById('metricTabs').innerHTML = Object.entries(metrics).map(([key, meta]) => \`
    <button class="tab \${key === selectedMetric ? 'active' : ''}" data-key="\${key}">\${meta.label}</button>
  \`).join('');
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
    ? \`<text x="\${x(i)}" y="\${height - 12}" text-anchor="middle" font-size="11" fill="#647084">\${r.date.slice(5)}</text>\`
    : '').join('');
  chart.innerHTML = \`
    <svg viewBox="0 0 \${width} \${height}" role="img" aria-label="\${meta.label} chart">
      <line x1="\${left}" y1="\${top}" x2="\${left}" y2="\${height - bottom}" stroke="#dce2ea"/>
      <line x1="\${left}" y1="\${height - bottom}" x2="\${width - right}" y2="\${height - bottom}" stroke="#dce2ea"/>
      <text x="8" y="\${top + 6}" font-size="11" fill="#647084">\${meta.format(max)}</text>
      <text x="8" y="\${height - bottom}" font-size="11" fill="#647084">\${meta.format(min)}</text>
      <path d="\${path}" fill="none" stroke="\${meta.color}" stroke-width="3"/>
      \${points.map(([cx, cy, r]) => \`<circle cx="\${cx}" cy="\${cy}" r="4" fill="\${meta.color}"><title>\${r.date}: \${meta.format(r.metrics[selectedMetric])}</title></circle>\`).join('')}
      \${labels}
    </svg>
  \`;
}

function renderWeightGoal(record) {
  const weight = record?.metrics?.weightKg;
  const target = record?.goal?.weightTargetKg || GOALS.weightKg;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / Math.max(.1, start - target)) * 100));
  document.getElementById('weightGoal').innerHTML = \`
    <div class="status-list">
      <div class="status-item"><span>現在</span><strong>\${metrics.weightKg.format(weight)}</strong></div>
      <div class="status-item"><span>目標</span><strong>\${target.toFixed(1)}kg</strong></div>
      <div class="status-item"><span>残り</span><strong>\${weight == null ? '-' : (weight - target).toFixed(1) + 'kg'}</strong></div>
      <div class="status-item"><span>推奨ペース</span><strong>2週間で1kg減</strong></div>
      <div class="progress"><span style="width:\${progress}%"></span></div>
    </div>
  \`;
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
  document.getElementById('dataStatus').innerHTML = \`
    <div class="status-list">
      <div class="status-item"><span>対象日数</span><strong>\${total}</strong></div>
      <div class="status-item"><span>レポート生成済み</span><strong class="ok">\${generated}</strong></div>
      <div class="status-item"><span>準備不足</span><strong class="warn">\${notReady}</strong></div>
      <div class="status-item"><span>体組成のみ</span><strong>\${bodyOnly}</strong></div>
      <div class="status-item"><span>筋トレ実績</span><strong class="warn">未連携</strong></div>
    </div>
  \`;
}

function renderTable() {
  document.getElementById('dailyRows').innerHTML = [...records].reverse().map(r => \`
    <tr>
      <td>\${r.date}</td>
      <td>\${statusLabel(r.status)}</td>
      <td>\${metrics.sleepHours.format(r.metrics.sleepHours)}</td>
      <td>\${metrics.steps.format(r.metrics.steps)}</td>
      <td>\${metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal)}</td>
      <td>\${metrics.weightKg.format(r.metrics.weightKg)}</td>
      <td>\${metrics.bodyFatPercent.format(r.metrics.bodyFatPercent)}</td>
      <td>\${r.metrics.bodyMassIndex == null ? '-' : r.metrics.bodyMassIndex.toFixed(1)}</td>
      <td>\${(r.missing || []).join(', ') || '-'}</td>
    </tr>
  \`).join('');
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
}`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
