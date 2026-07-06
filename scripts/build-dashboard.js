import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const reportsDir = join(root, 'data', 'reports');
const healthPlanetDir = join(root, 'data', 'healthplanet');
const outputDir = join(root, 'docs');

async function main() {
  const records = await buildRecords();
  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, 'health-data.json'), {
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
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

  return records;
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
      weightTargetKg: numberOrNull(goals.weightTargetKgByJuneEnd ?? 79),
      kgToTarget: numberOrNull(goals.kgToTarget),
    },
    files: {
      healthFile: input?.healthFile?.path || latestSkip?.healthFile || null,
      sleepFile: input?.sleepFile?.path || latestSkip?.sleepFile || null,
      healthPlanetFile: input?.healthPlanet?.path || latestSkip?.healthPlanet?.path || (healthPlanet ? `data/healthplanet/${date}.json` : null),
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

function dashboardHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Health Dashboard</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">Healthcare Agent</p>
      <h1>Health Dashboard</h1>
    </div>
    <div class="summary" id="summary"></div>
  </header>

  <main>
    <section class="kpis" id="kpis"></section>

    <section class="panel">
      <div class="panel-head">
        <h2>直近推移</h2>
        <div class="tabs" id="metricTabs"></div>
      </div>
      <div class="chart" id="chart"></div>
    </section>

    <section class="grid">
      <div class="panel">
        <div class="panel-head">
          <h2>体重目標</h2>
        </div>
        <div id="weightGoal"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>データ状態</h2>
        </div>
        <div id="dataStatus"></div>
      </div>
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
              <th>kcal</th>
              <th>体重</th>
              <th>体脂肪</th>
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
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #1d2430;
  --muted: #647084;
  --line: #dce2ea;
  --blue: #2563eb;
  --green: #0f9f6e;
  --orange: #f59e0b;
  --red: #dc2626;
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
.kpis {
  display: grid;
  grid-template-columns: repeat(5, minmax(150px, 1fr));
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
}
.panel {
  padding: 16px;
  margin-bottom: 14px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  margin-bottom: 14px;
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
.status-list {
  display: grid;
  gap: 8px;
}
.status-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
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
@media (max-width: 920px) {
  .topbar { display: block; }
  .summary { text-align: left; margin-top: 10px; }
  .kpis { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
  .grid { grid-template-columns: 1fr; }
}`;
}

function dashboardJs() {
  return `const metrics = {
  sleepHours: { label: '睡眠', unit: 'h', color: '#2563eb', format: v => v == null ? '-' : hours(v) },
  steps: { label: '歩数', unit: '歩', color: '#0f9f6e', format: v => v == null ? '-' : Math.round(v).toLocaleString('ja-JP') + '歩' },
  activeEnergyKcal: { label: '活動kcal', unit: 'kcal', color: '#f59e0b', format: v => v == null ? '-' : Math.round(v) + 'kcal' },
  weightKg: { label: '体重', unit: 'kg', color: '#7c3aed', format: v => v == null ? '-' : v.toFixed(1) + 'kg' },
  bodyFatPercent: { label: '体脂肪', unit: '%', color: '#dc2626', format: v => v == null ? '-' : v.toFixed(1) + '%' },
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
  renderKpis(latest);
  renderTabs();
  renderChart();
  renderWeightGoal(latest);
  renderStatus();
  renderTable();
}

function renderKpis(record) {
  const items = [
    ['睡眠', metrics.sleepHours.format(record?.metrics?.sleepHours), avgText(record, 'sleepHours')],
    ['歩数', metrics.steps.format(record?.metrics?.steps), avgText(record, 'steps')],
    ['活動', metrics.activeEnergyKcal.format(record?.metrics?.activeEnergyKcal), avgText(record, 'activeEnergyKcal')],
    ['体重', metrics.weightKg.format(record?.metrics?.weightKg), avgText(record, 'weightKg')],
    ['体脂肪', metrics.bodyFatPercent.format(record?.metrics?.bodyFatPercent), avgText(record, 'bodyFatPercent')],
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
    chart.innerHTML = '<p class="bad">データなし</p>';
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
  const target = record?.goal?.weightTargetKg || 79;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / (start - target)) * 100));
  document.getElementById('weightGoal').innerHTML = \`
    <div class="status-list">
      <div class="status-item"><span>現在</span><strong>\${metrics.weightKg.format(weight)}</strong></div>
      <div class="status-item"><span>目標</span><strong>\${target.toFixed(1)}kg</strong></div>
      <div class="status-item"><span>残り</span><strong>\${weight == null ? '-' : (weight - target).toFixed(1) + 'kg'}</strong></div>
      <div class="progress"><span style="width:\${progress}%"></span></div>
    </div>
  \`;
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
      <td>\${(r.missing || []).join(', ') || '-'}</td>
    </tr>
  \`).join('');
}

function avgText(record, key) {
  const avg = record?.average7?.[key];
  if (avg == null) return '7日平均なし';
  return '7日平均 ' + metrics[key].format(avg);
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
}`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
