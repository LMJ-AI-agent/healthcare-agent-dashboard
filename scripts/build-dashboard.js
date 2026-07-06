import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const reportsDir = join(root, 'data', 'reports');
const healthPlanetDir = join(root, 'data', 'healthplanet');
const outputDir = join(root, 'docs');

const GOALS = {
  weightKg: 79,
  steps: 8000,
  sleepHours: 6.5,
  activeEnergyKcal: 650,
  bodyFatPercent: 25,
};

async function main() {
  const records = await buildRecords();
  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, 'health-data.json'), {
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    goals: GOALS,
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
      weightTargetKg: numberOrNull(goals.weightTargetKgByJuneEnd ?? GOALS.weightKg),
      kgToTarget: numberOrNull(goals.kgToTarget),
    },
  };
}

function buildCoaching(record, previous, latest7) {
  const m = record.metrics;
  const prev = previous?.metrics || {};
  const kgToTarget = m.weightKg == null ? null : round1(m.weightKg - GOALS.weightKg);
  const sleepMissing = m.sleepHours == null;
  const stepsMissing = m.steps == null;
  const sleepLow = m.sleepHours != null && m.sleepHours < 6;
  const stepsLow = m.steps != null && m.steps < GOALS.steps;
  const bodyFatHigh = m.bodyFatPercent != null && m.bodyFatPercent >= 28;

  const topPriority = sleepMissing || stepsMissing
    ? '未取得データを確認'
    : sleepLow
      ? '回復を守りながら減量'
      : stepsLow
        ? '活動量を戻す'
        : '筋トレで体を締める';

  const actions = [
    stepsMissing
      ? `歩数データは未取得。今日の最低ラインは${GOALS.steps.toLocaleString('ja-JP')}歩。昼食後10分、夕方10分の2回に分けて歩く。`
      : stepsLow
        ? `歩数はあと${Math.max(0, GOALS.steps - Math.round(m.steps || 0)).toLocaleString('ja-JP')}歩。昼食後10分、夕方10分の2回に分けて歩く。`
        : '歩数は基準クリア。今日は追加で追い込みすぎず、食事と筋トレの質を優先する。',
    sleepMissing
      ? '睡眠データは未取得。回復状態が読めないので、筋トレは20分以内でフォーム重視にする。'
      : sleepLow
        ? '睡眠が短いので、筋トレはフォーム重視で各種目2セットまで。夜は就寝前30分のスマホ時間を削る。'
        : '筋トレは週3回ペースを維持。今日は下半身・背中・体幹のどれかを20分だけ実行する。',
    bodyFatHigh
      ? '体脂肪率は高め。主食を抜くより、毎食たんぱく質を先に食べて間食を1回減らす。'
      : '体脂肪率は管理圏内。体重だけで判断せず、筋トレ継続で見た目の変化を狙う。',
    kgToTarget != null && kgToTarget > 0
      ? `79.0kgまであと${kgToTarget.toFixed(1)}kg。2週間で1kg減のペースなら、今日は小さく確実に削る日。`
      : '79.0kg目標は達成圏。リバウンド防止として筋トレと睡眠を崩さない。',
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
    sevenDay: {
      sleepHours: round2(average(latest7.map((r) => r.metrics.sleepHours))),
      steps: round0(average(latest7.map((r) => r.metrics.steps))),
      activeEnergyKcal: round0(average(latest7.map((r) => r.metrics.activeEnergyKcal))),
      weightKg: round2(average(latest7.map((r) => r.metrics.weightKg))),
      bodyFatPercent: round2(average(latest7.map((r) => r.metrics.bodyFatPercent))),
    },
  };
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
        <h1>今日も一つ完了。79kgへ、体を作っていこう。</h1>
        <p class="lead" id="heroLead"></p>
        <div class="hero-actions">
          <span class="streak" id="todayScore"></span>
          <span class="streak alt" id="motivationLine"></span>
        </div>
      </div>
      <div class="hero-metrics" id="heroMetrics"></div>
    </section>

    <section class="panel victory-panel">
      <div>
        <p class="eyebrow">Today's Progress</p>
        <h2 id="victoryTitle">今日の達成状況</h2>
      </div>
      <div class="completion-ring" id="completionRing"></div>
      <div class="toast" id="feedbackToast" role="status" aria-live="polite"></div>
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
            <h2>筋トレ実績</h2>
          </div>
        </div>
        <div id="strengthPlan"></div>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Diet</p>
            <h2>食事ルール</h2>
          </div>
        </div>
        <div id="dietPlan"></div>
      </section>
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Workout Memo</p>
          <h2>その他の筋トレログ</h2>
        </div>
      </div>
      <textarea id="workoutMemo" class="memo-box" rows="4" placeholder="例: スクワット 10回 x 3、腕立て 8回 x 2。きつさ7/10。"></textarea>
      <div class="memo-foot">
        <span id="memoSaved"></span>
        <button class="ghost-button" id="clearToday">今日のチェックをリセット</button>
      </div>
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
            <p class="eyebrow">Log</p>
            <h2>完了ログ</h2>
          </div>
        </div>
        <div id="completionLog"></div>
      </section>
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Theme Stock</p>
          <h2>今後のテーマ</h2>
        </div>
        <span class="pill" id="themeCount"></span>
      </div>
      <div class="theme-input">
        <input id="themeInput" type="text" placeholder="例: 体脂肪率を下げるために夜の間食をなくす">
        <button id="addTheme" type="button">ストック</button>
      </div>
      <div id="themeStock"></div>
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Daily Log</p>
          <h2>日別データ</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日付</th>
              <th>完了</th>
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
  --panel: rgba(255, 255, 255, .92);
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
    radial-gradient(circle at 10% 8%, rgba(183, 227, 95, .24), transparent 28%),
    radial-gradient(circle at 90% 0%, rgba(27, 179, 166, .18), transparent 26%),
    linear-gradient(180deg, #fbfcf8 0%, var(--bg) 54%, #eef3ee 100%);
  color: var(--ink);
}
.shell { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 40px; }
.hero {
  min-height: 300px;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr);
  align-items: end;
  gap: 22px;
  padding: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(18, 38, 31, .96), rgba(25, 102, 76, .92));
  color: white;
  box-shadow: var(--shadow);
}
.eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 12px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
.hero .eyebrow { color: rgba(255,255,255,.7); }
h1, h2, h3 { margin: 0; letter-spacing: 0; }
h1 { max-width: 760px; font-size: clamp(36px, 5vw, 66px); line-height: 1.03; }
h2 { font-size: 20px; }
.lead { max-width: 720px; margin: 18px 0 0; color: rgba(255,255,255,.78); font-size: 16px; line-height: 1.7; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.streak {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 8px 13px;
  border-radius: 999px;
  background: rgba(183, 227, 95, .18);
  border: 1px solid rgba(255,255,255,.18);
  color: #faffec;
  font-weight: 850;
}
.streak.alt { background: rgba(255,255,255,.1); color: rgba(255,255,255,.82); }
.hero-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.hero-card { padding: 14px; min-height: 96px; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; background: rgba(255,255,255,.1); }
.hero-card span { color: rgba(255,255,255,.66); font-size: 12px; }
.hero-card strong { display: block; margin-top: 8px; font-size: 26px; }
.hero-card small { display: block; margin-top: 4px; color: rgba(255,255,255,.68); }
.panel, .kpi {
  border: 1px solid rgba(223,230,223,.9);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 10px 34px rgba(24, 41, 34, .07);
  backdrop-filter: blur(12px);
}
.panel { padding: 18px; margin-top: 16px; }
.victory-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: center;
  position: relative;
  overflow: hidden;
}
.completion-ring { width: 138px; height: 138px; }
.toast {
  position: absolute;
  right: 18px;
  bottom: 14px;
  opacity: 0;
  transform: translateY(8px);
  transition: .25s ease;
  padding: 10px 13px;
  border-radius: 999px;
  color: #064832;
  background: #ddf8e9;
  font-weight: 850;
}
.toast.show { opacity: 1; transform: translateY(0); }
.command-grid, .workout-grid, .lower-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(340px, .8fr); gap: 16px; }
.section-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.pill { display: inline-flex; align-items: center; min-height: 30px; padding: 6px 11px; border-radius: 999px; background: #e6f8ef; color: #086343; font-size: 13px; font-weight: 850; white-space: nowrap; }
.task-list, .plan-stack, .status-list, .score-list { display: grid; gap: 10px; }
.task-card, .plan-card {
  position: relative;
  padding: 14px;
  border: 1px solid #e4ece5;
  border-radius: 8px;
  background: #fff;
}
.task-card.done, .plan-card.done { border-color: rgba(21,149,107,.35); background: #f0fbf5; }
.task-row, .plan-card .top { display: grid; grid-template-columns: 42px 1fr auto; gap: 12px; align-items: center; }
.check-button {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 1px solid #d7e2d9;
  background: #f7faf6;
  color: #819089;
  cursor: pointer;
  font-size: 19px;
  font-weight: 950;
}
.done .check-button { color: white; background: var(--green); border-color: var(--green); }
.task-card strong, .plan-card h3 { display: block; font-size: 15px; }
.task-card p { margin: 4px 0 0; color: var(--muted); line-height: 1.55; }
.tag { padding: 5px 8px; border-radius: 999px; background: #f0f5ef; color: #4f5f56; font-size: 12px; font-weight: 850; }
.plan-card ul { margin: 12px 0 0; padding-left: 18px; color: var(--muted); line-height: 1.55; }
.memo-box { width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 13px; font: inherit; line-height: 1.6; color: var(--ink); background: #fff; }
.memo-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 13px; }
.ghost-button { border: 1px solid var(--line); background: #fff; color: var(--muted); border-radius: 999px; padding: 8px 12px; cursor: pointer; font-weight: 800; }
.theme-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-bottom: 12px; }
.theme-input input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 12px 13px; font: inherit; background: #fff; color: var(--ink); }
.theme-input button { border: 0; border-radius: 8px; padding: 0 16px; background: #12261f; color: white; font-weight: 900; cursor: pointer; }
.theme-list { display: grid; gap: 10px; }
.theme-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 13px; border: 1px solid #e4ece5; border-radius: 8px; background: #fff; }
.theme-card.active { border-color: rgba(21,149,107,.4); background: #f0fbf5; }
.theme-card strong { display: block; margin-bottom: 4px; font-size: 15px; }
.theme-card small { color: var(--muted); }
.theme-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.theme-actions button { border: 1px solid var(--line); border-radius: 999px; padding: 7px 10px; background: #fff; color: var(--muted); font-weight: 800; cursor: pointer; }
.theme-actions .primary { border-color: rgba(21,149,107,.25); background: #e6f8ef; color: #086343; }
.radar-layout { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(170px, .7fr); gap: 12px; align-items: center; }
.radar-layout svg { width: 100%; max-height: 300px; }
.score-row { display: grid; grid-template-columns: 76px 1fr 42px; gap: 8px; align-items: center; font-size: 13px; }
.mini-bar, .progress { overflow: hidden; border-radius: 999px; background: #e8eee8; }
.mini-bar { height: 8px; }
.progress { height: 14px; }
.mini-bar span, .progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--green), var(--lime)); }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
.kpi { padding: 15px; }
.kpi .label { color: var(--muted); font-size: 13px; font-weight: 750; }
.kpi .value { margin-top: 8px; font-size: 28px; font-weight: 950; }
.kpi .sub { margin-top: 6px; min-height: 34px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.tab { border: 1px solid var(--line); background: #fff; color: var(--muted); border-radius: 999px; padding: 8px 11px; cursor: pointer; font-weight: 750; }
.tab.active { color: #fff; border-color: #12261f; background: #12261f; }
.chart { min-height: 310px; }
.chart svg { width: 100%; height: 310px; display: block; }
.status-item { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.status-item span { color: var(--muted); }
.ok { color: var(--green); }
.warn { color: var(--orange); }
.bad { color: var(--red); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 11px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
@media (max-width: 1040px) {
  .hero, .command-grid, .workout-grid, .lower-grid { grid-template-columns: 1fr; }
  .kpis { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
}
@media (max-width: 720px) {
  .shell { width: min(100% - 20px, 1240px); padding-top: 10px; }
  .hero { padding: 20px; min-height: 0; }
  h1 { font-size: 36px; }
  .hero-metrics, .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .radar-layout, .victory-panel { grid-template-columns: 1fr; }
  .theme-input, .theme-card { grid-template-columns: 1fr; }
  .theme-actions { justify-content: flex-start; }
  .section-head { flex-direction: column; }
}`;
}

function dashboardJs() {
  return `const GOALS = { weightKg: 79, steps: 8000, sleepHours: 6.5, activeEnergyKcal: 650, bodyFatPercent: 25 };
const metrics = {
  weightKg: { label: '体重', color: '#3567e8', format: v => v == null ? '-' : v.toFixed(1) + 'kg' },
  bodyFatPercent: { label: '体脂肪率', color: '#df4b4b', format: v => v == null ? '-' : v.toFixed(1) + '%' },
  sleepHours: { label: '睡眠', color: '#7c5cff', format: v => v == null ? '-' : hours(v) },
  steps: { label: '歩数', color: '#15956b', format: v => v == null ? '-' : Math.round(v).toLocaleString('ja-JP') + '歩' },
  activeEnergyKcal: { label: '活動kcal', color: '#f29f3d', format: v => v == null ? '-' : Math.round(v) + 'kcal' },
};
const TASK_TITLES = ['活動量', '筋トレ', '食事', '減量ペース'];
let records = [];
let selectedMetric = 'weightKg';
let latestRecord = null;
let todayPlan = [];
let dayState = null;
let themeStore = null;

fetch('./health-data.json')
  .then(res => res.json())
  .then(data => {
    records = data.records || [];
    latestRecord = [...records].reverse().find(r => hasAnyMetric(r)) || records.at(-1);
    dayState = loadDayState(latestRecord?.date || todayIso());
    themeStore = loadThemeStore();
    render(data);
  });

function render(data) {
  const m = latestRecord?.metrics || {};
  const kgLeft = m.weightKg == null ? null : m.weightKg - GOALS.weightKg;
  todayPlan = buildTodayPlan(latestRecord);
  document.getElementById('heroLead').textContent = data.generatedAt
    ? '更新: ' + new Date(data.generatedAt).toLocaleString('ja-JP') + ' / ' + data.recordCount + '日分。チェックして進めるほど、今日のログと達成率が育ちます。'
    : '';
  renderHeroMetrics(latestRecord, kgLeft);
  renderCompletionSummary();
  renderCoaching();
  renderRadar(latestRecord);
  renderKpis(latestRecord);
  renderStrengthPlan();
  renderDietPlan();
  renderMemo();
  renderTabs();
  renderChart();
  renderWeightGoal(latestRecord);
  renderCompletionLog();
  renderThemeStock();
  renderTable();
  bindReset();
  bindThemeStock();
}

function buildTodayPlan(record) {
  const actions = record?.coaching?.actions?.length ? record.coaching.actions : ['体重・睡眠・歩数のデータ取得状態を確認する。'];
  const m = record?.metrics || {};
  const tired = m.sleepHours == null || m.sleepHours < 6;
  const strengthItems = tired
    ? [
        ['回復日メニュー', 'スクワット10回 x 2、壁腕立て10回 x 2、プランク20秒 x 2'],
        ['フォーム確認', '息が上がりすぎない強度で、動きを丁寧に確認する'],
      ]
    : [
        ['下半身', 'スクワット10回 x 3、ヒップヒンジ12回 x 3'],
        ['上半身', '腕立て8回 x 3、ローイング12回 x 3'],
        ['体幹', 'プランク30秒 x 3、デッドバグ左右10回 x 2'],
      ];
  const dietItems = [
    ['朝', 'たんぱく質を先に入れる。卵・ヨーグルト・鶏肉・魚のどれかを選ぶ'],
    ['昼', '主食はゼロにしない。量を固定して、揚げ物と甘い飲み物を避ける'],
    ['夜', '遅い時間は脂質を軽くする。米を減らすより、間食を先に削る'],
    ['今日の調整', m.steps == null || m.steps < GOALS.steps ? '夜の間食はなし。歩数不足は食事で取り返す' : '無理な食事制限をしない。たんぱく質を優先'],
  ];
  return [
    ...actions.map((text, i) => ({ id: 'coach-' + i, group: 'today', title: TASK_TITLES[i] || '今日の指示', text })),
    ...strengthItems.map(([title, text], i) => ({ id: 'strength-' + i, group: 'strength', title, text })),
    ...dietItems.map(([title, text], i) => ({ id: 'diet-' + i, group: 'diet', title, text })),
  ];
}

function renderHeroMetrics(record, kgLeft) {
  const m = record?.metrics || {};
  const seven = record?.coaching?.sevenDay || {};
  const completed = completedCount();
  const total = todayPlan.length;
  const cards = [
    ['今日の完了', completed + '/' + total, completionRate() + '% 達成'],
    ['現在体重', metrics.weightKg.format(m.weightKg), kgLeft == null ? '目標79.0kg' : '残り' + kgLeft.toFixed(1) + 'kg'],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), seven.bodyFatPercent == null ? '7日平均なし' : '7日平均 ' + seven.bodyFatPercent.toFixed(1) + '%'],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), seven.sleepHours == null ? '7日平均なし' : '7日平均 ' + hours(seven.sleepHours)],
  ];
  document.getElementById('heroMetrics').innerHTML = cards.map(([label, value, sub]) =>
    '<div class="hero-card"><span>' + label + '</span><strong>' + value + '</strong><small>' + sub + '</small></div>'
  ).join('');
}

function renderCompletionSummary() {
  const rate = completionRate();
  const completed = completedCount();
  const total = todayPlan.length;
  const activeTheme = currentThemeText();
  document.getElementById('todayScore').textContent = '今日の完了 ' + completed + '/' + total;
  document.getElementById('motivationLine').textContent = activeTheme || (rate >= 80 ? '最高です。この調子でいこう。' : rate >= 40 ? 'かなり進んでいます。あと少し。' : 'まず1つ押そう。流れができます。');
  document.getElementById('victoryTitle').textContent = rate >= 100 ? '今日のメニュー完了。素晴らしいです！' : '今日は ' + completed + '/' + total + ' 完了';
  document.getElementById('completionRing').innerHTML = ringSvg(rate);
}

function renderCoaching() {
  document.getElementById('topPriority').textContent = latestRecord?.coaching?.topPriority || 'データ確認';
  const items = todayPlan.filter(item => item.group === 'today');
  document.getElementById('coachActions').innerHTML = '<div class="task-list">' + items.map(item => taskCard(item)).join('') + '</div>';
  bindTaskButtons();
}

function renderStrengthPlan() {
  const items = todayPlan.filter(item => item.group === 'strength');
  document.getElementById('strengthPlan').innerHTML = '<div class="plan-stack">' + items.map(item => taskCard(item, true)).join('') + '</div>';
  bindTaskButtons();
}

function renderDietPlan() {
  const items = todayPlan.filter(item => item.group === 'diet');
  document.getElementById('dietPlan').innerHTML = '<div class="plan-stack">' + items.map(item => taskCard(item, true)).join('') + '</div>';
  bindTaskButtons();
}

function taskCard(item, compact = false) {
  const done = !!dayState.tasks[item.id];
  return '<div class="' + (compact ? 'plan-card' : 'task-card') + (done ? ' done' : '') + '" data-task-id="' + item.id + '">' +
    '<div class="task-row">' +
    '<button class="check-button" type="button" data-task-id="' + item.id + '" aria-label="' + escapeHtml(item.title) + 'を完了">' + (done ? '✓' : '') + '</button>' +
    '<div><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.text) + '</p></div>' +
    '<span class="tag">' + (done ? '完了' : '未完了') + '</span>' +
    '</div></div>';
}

function bindTaskButtons() {
  document.querySelectorAll('.check-button').forEach(button => {
    button.onclick = () => toggleTask(button.dataset.taskId);
  });
}

function toggleTask(id) {
  dayState.tasks[id] = !dayState.tasks[id];
  saveDayState();
  showFeedback(dayState.tasks[id] ? '素晴らしいです！1つ前進しました。' : '未完了に戻しました。調整OKです。');
  renderAfterStateChange();
}

function renderAfterStateChange() {
  renderCompletionSummary();
  renderHeroMetrics(latestRecord, latestRecord?.metrics?.weightKg == null ? null : latestRecord.metrics.weightKg - GOALS.weightKg);
  renderCoaching();
  renderStrengthPlan();
  renderDietPlan();
  renderCompletionLog();
  renderTable();
}

function renderMemo() {
  const memo = document.getElementById('workoutMemo');
  memo.value = dayState.memo || '';
  memo.oninput = () => {
    dayState.memo = memo.value;
    saveDayState();
    document.getElementById('memoSaved').textContent = '保存しました ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    renderCompletionLog();
  };
}

function bindReset() {
  document.getElementById('clearToday').onclick = () => {
    dayState = { date: dayState.date, tasks: {}, memo: '' };
    saveDayState();
    render(dataPlaceholder());
    showFeedback('今日のチェックをリセットしました。');
  };
}

function renderThemeStock() {
  const themes = themeStore?.themes || [];
  const activeId = themeStore?.activeId || null;
  document.getElementById('themeCount').textContent = themes.length + '件ストック';
  document.getElementById('themeStock').innerHTML = themes.length
    ? '<div class="theme-list">' + themes.map(theme => (
      '<div class="theme-card ' + (theme.id === activeId ? 'active' : '') + '" data-theme-id="' + theme.id + '">' +
      '<div><strong>' + escapeHtml(theme.text) + '</strong><small>' + new Date(theme.createdAt).toLocaleString('ja-JP') + (theme.id === activeId ? ' / 今のテーマ' : '') + '</small></div>' +
      '<div class="theme-actions">' +
      '<button class="primary" type="button" data-theme-action="activate" data-theme-id="' + theme.id + '">今のテーマにする</button>' +
      '<button type="button" data-theme-action="delete" data-theme-id="' + theme.id + '">削除</button>' +
      '</div></div>'
    )).join('') + '</div>'
    : '<div class="status-list"><div class="status-item"><span>ストック</span><strong>まだありません</strong></div></div>';
}

function bindThemeStock() {
  document.getElementById('addTheme').onclick = () => addThemeFromInput();
  document.getElementById('themeInput').onkeydown = event => {
    if (event.key === 'Enter') addThemeFromInput();
  };
  document.querySelectorAll('[data-theme-action]').forEach(button => {
    button.onclick = () => {
      if (button.dataset.themeAction === 'activate') activateTheme(button.dataset.themeId);
      if (button.dataset.themeAction === 'delete') deleteTheme(button.dataset.themeId);
    };
  });
}

function addThemeFromInput() {
  const input = document.getElementById('themeInput');
  const text = input.value.trim();
  if (!text) return;
  const theme = { id: 'theme-' + Date.now(), text, createdAt: new Date().toISOString() };
  themeStore.themes.unshift(theme);
  themeStore.activeId = theme.id;
  saveThemeStore();
  input.value = '';
  showFeedback('今後のテーマとしてストックしました。');
  renderCompletionSummary();
  renderThemeStock();
  bindThemeStock();
}

function activateTheme(id) {
  themeStore.activeId = id;
  saveThemeStore();
  showFeedback('今のテーマに設定しました。');
  renderCompletionSummary();
  renderThemeStock();
  bindThemeStock();
}

function deleteTheme(id) {
  themeStore.themes = themeStore.themes.filter(theme => theme.id !== id);
  if (themeStore.activeId === id) themeStore.activeId = themeStore.themes[0]?.id || null;
  saveThemeStore();
  showFeedback('テーマを削除しました。');
  renderCompletionSummary();
  renderThemeStock();
  bindThemeStock();
}

function currentThemeText() {
  const active = (themeStore?.themes || []).find(theme => theme.id === themeStore.activeId);
  return active ? '今のテーマ: ' + active.text : '';
}

function renderCompletionLog() {
  const doneItems = todayPlan.filter(item => dayState.tasks[item.id]);
  document.getElementById('completionLog').innerHTML =
    '<div class="status-list">' +
    '<div class="status-item"><span>今日の実績</span><strong>' + completedCount() + '/' + todayPlan.length + ' 完了</strong></div>' +
    '<div class="status-item"><span>達成率</span><strong>' + completionRate() + '%</strong></div>' +
    '<div class="status-item"><span>完了項目</span><strong>' + (doneItems.length ? doneItems.map(i => i.title).join('、') : 'まだなし') + '</strong></div>' +
    '<div class="status-item"><span>筋トレメモ</span><strong>' + (dayState.memo ? escapeHtml(dayState.memo.slice(0, 42)) : '未入力') + '</strong></div>' +
    '</div>';
}

function renderRadar(record) {
  const scores = buildScores(record);
  const labels = scores.map(s => s.label);
  const values = scores.map(s => s.score);
  const cx = 150, cy = 150, maxR = 104;
  const points = values.map((score, i) => point(cx, cy, maxR * score / 100, i, values.length));
  const grid = [20,40,60,80,100].map(level => '<polygon points="' + values.map((_, i) => point(cx, cy, maxR * level / 100, i, values.length).join(',')).join(' ') + '" fill="none" stroke="#dfe6df" stroke-width="1"/>').join('');
  const axis = labels.map((label, i) => {
    const end = point(cx, cy, maxR, i, labels.length);
    const text = point(cx, cy, maxR + 22, i, labels.length);
    return '<line x1="' + cx + '" y1="' + cy + '" x2="' + end[0] + '" y2="' + end[1] + '" stroke="#dfe6df"/><text x="' + text[0] + '" y="' + text[1] + '" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#66736d">' + label + '</text>';
  }).join('');
  document.getElementById('radar').innerHTML =
    '<div class="radar-layout"><svg viewBox="0 0 300 300" role="img" aria-label="5角形パラメータ">' + grid + axis +
    '<polygon points="' + points.map(p => p.join(',')).join(' ') + '" fill="rgba(21,149,107,.24)" stroke="#15956b" stroke-width="3"/>' +
    points.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#12261f"/>').join('') +
    '</svg><div class="score-list">' + scores.map(s => '<div class="score-row"><span>' + s.label + '</span><div class="mini-bar"><span style="width:' + s.score + '%"></span></div><strong>' + s.score + '</strong></div>').join('') + '</div></div>';
}

function buildScores(record) {
  const m = record?.metrics || {};
  return [
    { label: '減量', score: clamp(100 - Math.max(0, (m.weightKg ?? 84) - GOALS.weightKg) * 12, 0, 100) },
    { label: '活動', score: clamp(((m.steps ?? 0) / GOALS.steps) * 100, 0, 100) },
    { label: '睡眠', score: clamp(((m.sleepHours ?? 0) / GOALS.sleepHours) * 100, 0, 100) },
    { label: '体脂肪', score: clamp(100 - Math.max(0, (m.bodyFatPercent ?? 32) - GOALS.bodyFatPercent) * 9, 0, 100) },
    { label: '実行', score: completionRate() },
  ].map(s => ({ ...s, score: Math.round(s.score) }));
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

function renderTabs() {
  document.getElementById('metricTabs').innerHTML = Object.entries(metrics).map(([key, meta]) =>
    '<button class="tab ' + (key === selectedMetric ? 'active' : '') + '" data-key="' + key + '">' + meta.label + '</button>'
  ).join('');
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => { selectedMetric = btn.dataset.key; renderTabs(); renderChart(); });
  });
}

function renderChart() {
  const meta = metrics[selectedMetric];
  const rows = records.filter(r => r.metrics?.[selectedMetric] != null);
  const values = rows.map(r => r.metrics[selectedMetric]);
  const chart = document.getElementById('chart');
  if (!values.length) { chart.innerHTML = '<p class="bad">この項目のデータがありません</p>'; return; }
  const min = Math.min(...values), max = Math.max(...values);
  const pad = max === min ? 1 : (max - min) * 0.15;
  const lo = min - pad, hi = max + pad;
  const width = 940, height = 310, left = 56, right = 20, top = 22, bottom = 44;
  const x = i => left + i * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = v => top + (hi - v) * ((height - top - bottom) / Math.max(1, hi - lo));
  const points = rows.map((r, i) => [x(i), y(r.metrics[selectedMetric]), r]);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = path + ' L' + points.at(-1)[0].toFixed(1) + ',' + (height - bottom) + ' L' + points[0][0].toFixed(1) + ',' + (height - bottom) + ' Z';
  const labels = rows.map((r, i) => i % Math.ceil(rows.length / 8) === 0 || i === rows.length - 1 ? '<text x="' + x(i) + '" y="' + (height - 13) + '" text-anchor="middle" font-size="11" fill="#66736d">' + r.date.slice(5) + '</text>' : '').join('');
  chart.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + meta.label + ' chart">' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<line x1="' + left + '" y1="' + (height - bottom) + '" x2="' + (width - right) + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<path d="' + area + '" fill="' + meta.color + '" opacity=".11"/>' +
    '<path d="' + path + '" fill="none" stroke="' + meta.color + '" stroke-width="3.5"/>' +
    points.map(([cx, cy, r]) => '<circle cx="' + cx + '" cy="' + cy + '" r="4.5" fill="#fff" stroke="' + meta.color + '" stroke-width="3"><title>' + r.date + ': ' + meta.format(r.metrics[selectedMetric]) + '</title></circle>').join('') +
    '<text x="8" y="' + (top + 6) + '" font-size="11" fill="#66736d">' + meta.format(max) + '</text>' +
    '<text x="8" y="' + (height - bottom) + '" font-size="11" fill="#66736d">' + meta.format(min) + '</text>' + labels + '</svg>';
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

function renderTable() {
  document.getElementById('dailyRows').innerHTML = [...records].reverse().map(r => {
    const state = loadDayState(r.date);
    const total = r.date === latestRecord?.date ? todayPlan.length : Object.keys(state.tasks || {}).length;
    const done = Object.values(state.tasks || {}).filter(Boolean).length;
    return '<tr><td>' + r.date + '</td><td>' + done + '/' + total + '</td><td>' + metrics.sleepHours.format(r.metrics.sleepHours) + '</td><td>' + metrics.steps.format(r.metrics.steps) + '</td><td>' + metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal) + '</td><td>' + metrics.weightKg.format(r.metrics.weightKg) + '</td><td>' + metrics.bodyFatPercent.format(r.metrics.bodyFatPercent) + '</td><td>' + (r.metrics.bodyMassIndex == null ? '-' : r.metrics.bodyMassIndex.toFixed(1)) + '</td></tr>';
  }).join('');
}

function loadDayState(date) {
  try {
    const raw = localStorage.getItem('dietCoach:' + date);
    return raw ? { date, tasks: {}, memo: '', ...JSON.parse(raw) } : { date, tasks: {}, memo: '' };
  } catch {
    return { date, tasks: {}, memo: '' };
  }
}
function saveDayState() { localStorage.setItem('dietCoach:' + dayState.date, JSON.stringify(dayState)); }
function loadThemeStore() {
  try {
    const raw = localStorage.getItem('dietCoach:themes');
    return raw ? { themes: [], activeId: null, ...JSON.parse(raw) } : { themes: [], activeId: null };
  } catch {
    return { themes: [], activeId: null };
  }
}
function saveThemeStore() { localStorage.setItem('dietCoach:themes', JSON.stringify(themeStore)); }
function completedCount() { return Object.values(dayState?.tasks || {}).filter(Boolean).length; }
function completionRate() { return todayPlan.length ? Math.round((completedCount() / todayPlan.length) * 100) : 0; }
function showFeedback(text) {
  const toast = document.getElementById('feedbackToast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showFeedback.timer);
  showFeedback.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}
function ringSvg(rate) {
  const r = 52, c = Math.PI * 2 * r, offset = c * (1 - rate / 100);
  return '<svg viewBox="0 0 138 138"><circle cx="69" cy="69" r="' + r + '" fill="none" stroke="#e8eee8" stroke-width="13"/><circle cx="69" cy="69" r="' + r + '" fill="none" stroke="#15956b" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 69 69)"/><text x="69" y="65" text-anchor="middle" font-size="28" font-weight="900" fill="#15201c">' + rate + '%</text><text x="69" y="88" text-anchor="middle" font-size="12" font-weight="800" fill="#66736d">完了</text></svg>';
}
function dataPlaceholder() { return { generatedAt: new Date().toISOString(), recordCount: records.length }; }
function point(cx, cy, r, index, total) { const angle = -Math.PI / 2 + index * 2 * Math.PI / total; return [Math.round((cx + Math.cos(angle) * r) * 10) / 10, Math.round((cy + Math.sin(angle) * r) * 10) / 10]; }
function goalText(value, target, unit) { if (value == null) return '目標 ' + target + unit; const diff = value - target; return diff <= 0 ? '目標達成' : '目標まであと' + diff.toFixed(1) + unit; }
function targetText(value, target, unit) { if (value == null) return '目標 ' + target.toLocaleString('ja-JP') + unit; const diff = value - target; return diff >= 0 ? '目標比 +' + Math.round(diff).toLocaleString('ja-JP') + unit : '目標まで ' + Math.abs(Math.round(diff)).toLocaleString('ja-JP') + unit; }
function deltaText(value, unit) { if (value == null) return '前回比データなし'; const sign = value > 0 ? '+' : ''; if (unit === 'h') return '前回比 ' + sign + value.toFixed(2) + '時間'; return '前回比 ' + sign + value.toFixed(unit === '%' ? 1 : 0) + unit; }
function hasAnyMetric(record) { return record && Object.values(record.metrics || {}).some(v => v != null); }
function hours(value) { if (value == null || !Number.isFinite(Number(value))) return '-'; const mins = Math.round(Number(value) * 60); return Math.floor(mins / 60) + '時間' + String(mins % 60).padStart(2, '0') + '分'; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }`;
}

async function readLatestReadinessSkip(date) {
  const dir = join(reportsDir, date);
  const files = (await listFilesSafe(dir)).filter((name) => /^readiness-skip-.+\.json$/.test(name)).sort();
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
function findPreviousWithMetrics(records, index) {
  for (let i = index - 1; i >= 0; i -= 1) if (hasAnyMetric(records[i])) return records[i];
  return null;
}
function numberOrNull(value) { return value == null || !Number.isFinite(Number(value)) ? null : Number(value); }
function average(values) {
  const nums = values.filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}
function delta(current, previous) { return current == null || previous == null ? null : round2(Number(current) - Number(previous)); }
function round0(value) { return value == null ? null : Math.round(Number(value)); }
function round1(value) { return value == null ? null : Math.round(Number(value) * 10) / 10; }
function round2(value) { return value == null ? null : Math.round(Number(value) * 100) / 100; }
function hasAnyMetric(record) { return record && Object.values(record.metrics || {}).some((value) => value != null); }

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
