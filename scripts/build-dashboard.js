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

  return records.map((record, index) => {
    const previous = findPreviousWithMetrics(records, index);
    const latest7 = records.slice(Math.max(0, index - 6), index + 1);
    return { ...record, coaching: buildCoaching(record, previous, latest7) };
  });
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

function buildCoaching(record, previous, latest7) {
  const m = record.metrics;
  const prev = previous?.metrics || {};
  const target = record.goal.weightTargetKg || DEFAULT_WEIGHT_TARGET_KG;
  const sevenDay = {
    sleepHours: round2(average(latest7.map((r) => r.metrics.sleepHours))),
    steps: round0(average(latest7.map((r) => r.metrics.steps))),
    activeEnergyKcal: round0(average(latest7.map((r) => r.metrics.activeEnergyKcal))),
    weightKg: round2(average(latest7.map((r) => r.metrics.weightKg))),
    bodyFatPercent: round2(average(latest7.map((r) => r.metrics.bodyFatPercent))),
  };
  const kgToTarget = m.weightKg == null ? null : round1(m.weightKg - target);
  const sleepLow = m.sleepHours != null && m.sleepHours < 6;
  const stepsLow = m.steps != null && m.steps < STEP_TARGET;
  const bodyFatHigh = m.bodyFatPercent != null && m.bodyFatPercent >= 28;

  const topPriority = sleepLow
    ? '回復を守りながら減量'
    : m.sleepHours == null || m.steps == null
      ? '未取得データを確認'
    : stepsLow
      ? '活動量を戻す'
      : '筋トレで体を締める';

  const actions = [
    m.steps == null
      ? `歩数データは未取得。今日の最低ラインは${STEP_TARGET.toLocaleString('ja-JP')}歩。昼食後10分、夕方10分の2回に分けて歩く。`
      : stepsLow
      ? `歩数はあと${Math.max(0, STEP_TARGET - Math.round(m.steps || 0)).toLocaleString('ja-JP')}歩。昼食後10分、夕方10分の2回に分けて歩く。`
      : `歩数は基準クリア。今日は追加で追い込みすぎず、食事と筋トレの質を優先する。`,
    m.sleepHours == null
      ? `睡眠データは未取得。回復状態が読めないので、筋トレは20分以内でフォーム重視にする。`
      : sleepLow
      ? `睡眠が短いので、筋トレはフォーム重視で各種目2セットまで。夜は就寝前30分のスマホ時間を削る。`
      : `筋トレは週3回ペースを維持。今日は下半身・背中・体幹のどれかを20分だけ実行する。`,
    bodyFatHigh
      ? `体脂肪率は高め。主食を抜くより、毎食たんぱく質を先に食べて間食を1回減らす。`
      : `体脂肪率は管理圏内。体重だけで判断せず、筋トレ継続で見た目の変化を狙う。`,
    kgToTarget != null && kgToTarget > 0
      ? `79.0kgまであと${kgToTarget.toFixed(1)}kg。2週間で1kg減のペースなら、今日は小さく確実に削る日。`
      : `79.0kg目標は達成圏。リバウンド防止として筋トレと睡眠を崩さない。`,
  ];

  return {
    topPriority,
    actions,
    deltas: {
      weightKg: delta(m.weightKg, prev.weightKg),
      bodyFatPercent: delta(m.bodyFatPercent, prev.bodyFatPercent),
      sleepHours: delta(m.sleepHours, prev.sleepHours),
      steps: delta(m.steps, prev.steps),
      activeEnergyKcal: delta(m.activeEnergyKcal, prev.activeEnergyKcal),
    },
    sevenDay,
  };
}

function findPreviousWithMetrics(records, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (hasAnyMetric(records[i])) return records[i];
  }
  return null;
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

function round0(value) {
  return value == null ? null : Math.round(Number(value));
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
  <main class="shell">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Diet Coach / Personal Trainer</p>
        <h1>79kgへ落としながら、仕事で動ける体を作る</h1>
        <p class="lead" id="heroLead"></p>
      </div>
      <div class="hero-metrics" id="heroMetrics"></div>
    </section>

    <section class="command-grid">
      <section class="panel command-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Today</p>
            <h2>今日の指示</h2>
          </div>
          <span class="pill" id="topPriority"></span>
        </div>
        <div id="coachActions"></div>
      </section>
      <section class="panel radar-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Condition Pentagon</p>
            <h2>5角形パラメータ</h2>
          </div>
        </div>
        <div id="radar"></div>
      </section>
    </section>

    <section class="kpis" id="kpis"></section>

    <section class="workout-grid">
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Training</p>
            <h2>今週の筋トレメニュー</h2>
          </div>
        </div>
        <div id="strengthPlan"></div>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Diet</p>
            <h2>今日の食事ルール</h2>
          </div>
        </div>
        <div id="dietPlan"></div>
      </section>
    </section>

    <section class="panel chart-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Trend</p>
          <h2>推移グラフ</h2>
        </div>
        <div class="tabs" id="metricTabs"></div>
      </div>
      <div class="chart" id="chart"></div>
    </section>

    <section class="lower-grid">
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Goal</p>
            <h2>79kg目標</h2>
          </div>
        </div>
        <div id="weightGoal"></div>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Data</p>
            <h2>取得状態</h2>
          </div>
        </div>
        <div id="dataStatus"></div>
      </section>
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Log</p>
          <h2>日別データ</h2>
        </div>
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
  --bg: #f3f5f1;
  --panel: rgba(255, 255, 255, .9);
  --panel-strong: #ffffff;
  --ink: #15201c;
  --muted: #66736d;
  --line: #dfe6df;
  --green: #15956b;
  --lime: #b7e35f;
  --teal: #1bb3a6;
  --blue: #3567e8;
  --orange: #f29f3d;
  --red: #df4b4b;
  --shadow: 0 18px 50px rgba(24, 41, 34, .12);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at 12% 10%, rgba(183, 227, 95, .22), transparent 28%),
    radial-gradient(circle at 92% 0%, rgba(27, 179, 166, .16), transparent 26%),
    linear-gradient(180deg, #fbfcf8 0%, var(--bg) 54%, #eef3ee 100%);
  color: var(--ink);
}
.shell {
  width: min(1240px, calc(100% - 32px));
  margin: 0 auto;
  padding: 24px 0 40px;
}
.hero {
  min-height: 270px;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr);
  align-items: end;
  gap: 22px;
  padding: 30px;
  border: 1px solid rgba(255,255,255,.68);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(18, 38, 31, .96), rgba(25, 102, 76, .9)),
    linear-gradient(45deg, rgba(183, 227, 95, .18), transparent);
  color: white;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.hero .eyebrow { color: rgba(255,255,255,.7); }
h1, h2 { margin: 0; letter-spacing: 0; }
h1 {
  max-width: 760px;
  font-size: clamp(34px, 5vw, 64px);
  line-height: 1.03;
}
h2 { font-size: 20px; }
.lead {
  max-width: 720px;
  margin: 18px 0 0;
  color: rgba(255,255,255,.76);
  font-size: 16px;
  line-height: 1.7;
}
.hero-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.hero-card {
  padding: 14px;
  min-height: 92px;
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 8px;
  background: rgba(255,255,255,.1);
}
.hero-card span { color: rgba(255,255,255,.66); font-size: 12px; }
.hero-card strong { display: block; margin-top: 8px; font-size: 26px; }
.hero-card small { display: block; margin-top: 4px; color: rgba(255,255,255,.68); }
.command-grid, .workout-grid, .lower-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(340px, .8fr);
  gap: 16px;
  margin-top: 16px;
}
.panel, .kpi {
  border: 1px solid rgba(223,230,223,.9);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 10px 34px rgba(24, 41, 34, .07);
  backdrop-filter: blur(12px);
}
.panel {
  padding: 18px;
}
.section-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 6px 11px;
  border: 1px solid rgba(21,149,107,.25);
  border-radius: 999px;
  background: #e6f8ef;
  color: #086343;
  font-size: 13px;
  font-weight: 800;
  white-space: nowrap;
}
.action-list {
  display: grid;
  gap: 10px;
}
.action-item {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 12px;
  align-items: start;
  padding: 13px;
  border: 1px solid #e4ece5;
  border-radius: 8px;
  background: #fff;
}
.action-no {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #12261f;
  color: white;
  font-weight: 900;
}
.action-item strong { display: block; margin-bottom: 3px; font-size: 14px; }
.action-item p { margin: 0; color: var(--muted); line-height: 1.55; }
.radar-layout {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(170px, .7fr);
  gap: 12px;
  align-items: center;
}
.radar-layout svg {
  width: 100%;
  max-height: 300px;
}
.score-list {
  display: grid;
  gap: 8px;
}
.score-row {
  display: grid;
  grid-template-columns: 76px 1fr 42px;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.mini-bar {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #e8eee8;
}
.mini-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--green), var(--lime));
}
.kpis {
  display: grid;
  grid-template-columns: repeat(5, minmax(150px, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.kpi {
  padding: 15px;
}
.kpi .label {
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
}
.kpi .value {
  margin-top: 8px;
  font-size: 28px;
  font-weight: 900;
}
.kpi .sub {
  margin-top: 6px;
  min-height: 34px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
.plan-stack {
  display: grid;
  gap: 10px;
}
.plan-card {
  padding: 14px;
  border: 1px solid #e4ece5;
  border-radius: 8px;
  background: #fff;
}
.plan-card .top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.plan-card h3 {
  margin: 0;
  font-size: 16px;
}
.tag {
  padding: 5px 8px;
  border-radius: 999px;
  background: #f0f5ef;
  color: #4f5f56;
  font-size: 12px;
  font-weight: 800;
}
.plan-card ul {
  margin: 12px 0 0;
  padding-left: 18px;
  color: var(--muted);
  line-height: 1.55;
}
.chart-panel { margin-top: 16px; }
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tab {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 999px;
  padding: 8px 11px;
  cursor: pointer;
  font-weight: 700;
}
.tab.active {
  color: #fff;
  border-color: #12261f;
  background: #12261f;
}
.chart { min-height: 310px; }
.chart svg {
  width: 100%;
  height: 310px;
  display: block;
}
.status-list {
  display: grid;
  gap: 8px;
}
.status-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.status-item span { color: var(--muted); }
.progress {
  height: 14px;
  border-radius: 999px;
  background: #e8eee8;
  overflow: hidden;
}
.progress span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--green), var(--lime));
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
  padding: 11px 8px;
  border-bottom: 1px solid var(--line);
  text-align: right;
  white-space: nowrap;
}
th:first-child, td:first-child,
th:nth-child(2), td:nth-child(2) {
  text-align: left;
}
@media (max-width: 1040px) {
  .hero, .command-grid, .workout-grid, .lower-grid { grid-template-columns: 1fr; }
  .kpis { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
}
@media (max-width: 720px) {
  .shell { width: min(100% - 20px, 1240px); padding-top: 10px; }
  .hero { padding: 20px; min-height: 0; }
  h1 { font-size: 36px; }
  .hero-metrics, .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .radar-layout { grid-template-columns: 1fr; }
  .section-head { flex-direction: column; }
}
@media (max-width: 440px) {
  .hero-metrics, .kpis { grid-template-columns: 1fr; }
}`;
}

function dashboardJs() {
  return `const GOALS = {
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
}`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
