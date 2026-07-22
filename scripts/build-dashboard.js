import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const reportsDir = join(root, 'data', 'reports');
const healthPlanetDir = join(root, 'data', 'healthplanet');
const outputDir = join(root, 'docs');

const GOALS = {
  weightKg: 79,
  deadline: '2026-07-31',
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

    <section class="goal-command-panel">
      <div class="goal-hero-card panel">
        <div>
          <p class="eyebrow">Goal Control</p>
          <h2>目標管理</h2>
        </div>
        <div id="goalOverview"></div>
      </div>
      <section class="panel goal-settings-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Target Settings</p>
            <h2>目標値を編集</h2>
          </div>
          <span class="pill" id="goalSaveStatus">未保存の変更なし</span>
        </div>
        <div class="goal-form">
          <label>目標体重<input id="goalWeightInput" type="number" step="0.1" min="35" max="160"></label>
          <label>期限<input id="goalDeadlineInput" type="date"></label>
          <label>歩数目標<input id="goalStepsInput" type="number" step="500" min="1000" max="30000"></label>
          <label>睡眠目標<input id="goalSleepInput" type="number" step="0.25" min="3" max="10"></label>
          <label>体脂肪率目標<input id="goalBodyFatInput" type="number" step="0.1" min="5" max="45"></label>
        </div>
        <div class="goal-buttons">
          <button class="primary-button" id="saveGoals" type="button">保存して反映</button>
          <button class="ghost-button" id="resetGoals" type="button">初期値に戻す</button>
        </div>
      </section>
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

    <section class="panel action-details-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Action Details</p>
          <h2>実行項目</h2>
        </div>
        <span class="pill" id="actionDetailCount"></span>
      </div>
      <div id="actionDetails"></div>
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
        <div class="inline-memo">
          <p class="eyebrow">Workout Memo</p>
          <textarea id="workoutMemo" class="memo-box" rows="4" placeholder="例: スクワット 10回 x 3、腕立て 8回 x 2。きつさ7/10。"></textarea>
          <div class="memo-foot">
            <span id="memoSaved"></span>
            <button class="ghost-button" id="clearToday">今日のチェックをリセット</button>
          </div>
        </div>
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
  color-scheme: dark;
  --bg: #101114;
  --panel: rgba(24, 27, 32, .88);
  --panel-strong: #f6f1e8;
  --ink: #f7f2e8;
  --ink-dark: #181b20;
  --muted: #9aa39c;
  --line: #30363a;
  --green: #3ee084;
  --lime: #d9ff5f;
  --teal: #38d2c0;
  --blue: #7aa7ff;
  --orange: #ffb454;
  --red: #ff6f6f;
  --shadow: 0 22px 70px rgba(0, 0, 0, .34);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background:
    linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(180deg, rgba(255,255,255,.03) 1px, transparent 1px),
    linear-gradient(135deg, #111317 0%, #171a1f 45%, #0d0f12 100%);
  background-size: 44px 44px, 44px 44px, auto;
  color: var(--ink);
}
.shell { width: min(1380px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 40px; }
.hero {
  min-height: 300px;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr);
  align-items: end;
  gap: 22px;
  padding: 34px;
  border-radius: 8px;
  border: 1px solid rgba(217,255,95,.24);
  background:
    linear-gradient(120deg, rgba(23, 26, 31, .98), rgba(31, 42, 36, .96)),
    linear-gradient(90deg, rgba(217,255,95,.18), transparent);
  color: var(--ink);
  box-shadow: var(--shadow);
}
.eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 12px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
.hero .eyebrow { color: rgba(217,255,95,.82); }
h1, h2, h3 { margin: 0; letter-spacing: 0; }
h1 { max-width: 760px; font-size: clamp(36px, 5vw, 66px); line-height: 1.03; }
h2 { font-size: 20px; }
.lead { max-width: 720px; margin: 18px 0 0; color: rgba(247,242,232,.72); font-size: 16px; line-height: 1.7; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.streak {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 8px 13px;
  border-radius: 999px;
  background: rgba(217, 255, 95, .16);
  border: 1px solid rgba(217,255,95,.28);
  color: #f7ffd1;
  font-weight: 850;
}
.streak.alt { background: rgba(255,255,255,.08); color: rgba(247,242,232,.82); }
.hero-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.hero-card { padding: 15px; min-height: 104px; border: 1px solid rgba(247,242,232,.14); border-radius: 8px; background: rgba(255,255,255,.07); }
.hero-card span { color: rgba(247,242,232,.66); font-size: 12px; }
.hero-card strong { display: block; margin-top: 8px; font-size: 26px; }
.hero-card small { display: block; margin-top: 4px; color: rgba(247,242,232,.68); }
.panel, .kpi {
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 14px 45px rgba(0, 0, 0, .21);
  backdrop-filter: blur(16px);
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
  color: #102017;
  background: var(--lime);
  font-weight: 850;
}
.toast.show { opacity: 1; transform: translateY(0); }
.goal-command-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(440px, .75fr); gap: 16px; }
.goal-hero-card { display: grid; grid-template-columns: minmax(0, .28fr) minmax(0, 1fr); gap: 18px; align-items: center; }
.goal-overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; align-items: stretch; }
.goal-stat { min-height: 118px; padding: 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.055); }
.goal-stat.primary { color: var(--ink-dark); background: linear-gradient(135deg, var(--lime), #f8ffd2); border: 0; }
.goal-stat span { display: block; color: inherit; opacity: .68; font-size: 12px; font-weight: 850; }
.goal-stat strong { display: block; margin-top: 9px; font-size: 34px; line-height: 1; }
.goal-stat small { display: block; margin-top: 9px; color: inherit; opacity: .72; line-height: 1.45; }
.goal-progress { grid-column: 1 / -1; height: 12px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.11); }
.goal-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--lime), var(--teal), var(--blue)); }
.goal-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.goal-form label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 850; }
.goal-form input {
  width: 100%;
  min-height: 42px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px;
  padding: 9px 11px;
  background: rgba(255,255,255,.06);
  color: var(--ink);
  font: inherit;
}
.goal-buttons { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.primary-button { border: 0; border-radius: 8px; padding: 10px 14px; background: var(--lime); color: var(--ink-dark); font-weight: 950; cursor: pointer; }
.command-grid, .workout-grid, .lower-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(340px, .8fr); gap: 16px; }
.section-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.pill { display: inline-flex; align-items: center; min-height: 30px; padding: 6px 11px; border-radius: 999px; background: rgba(217,255,95,.14); color: var(--lime); border: 1px solid rgba(217,255,95,.2); font-size: 13px; font-weight: 850; white-space: nowrap; }
.task-list, .plan-stack, .status-list, .score-list { display: grid; gap: 10px; }
.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.summary-card { min-height: 112px; padding: 15px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.055); }
.summary-card span { display: block; color: var(--muted); font-size: 12px; font-weight: 800; }
.summary-card strong { display: block; margin-top: 8px; font-size: 30px; line-height: 1; }
.summary-card small { display: block; margin-top: 8px; color: var(--muted); line-height: 1.45; }
.action-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.task-card, .plan-card {
  position: relative;
  padding: 14px;
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 8px;
  background: rgba(255,255,255,.055);
  cursor: pointer;
}
.task-card.done, .plan-card.done { border-color: rgba(217,255,95,.36); background: rgba(217,255,95,.11); }
.task-row, .plan-card .top { display: grid; grid-template-columns: 42px 1fr auto; gap: 12px; align-items: center; }
.check-button {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(255,255,255,.06);
  color: var(--muted);
  cursor: pointer;
  font-size: 19px;
  font-weight: 950;
}
.done .check-button { color: var(--ink-dark); background: var(--lime); border-color: var(--lime); }
.inline-memo { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.task-card strong, .plan-card h3 { display: block; font-size: 15px; }
.task-card p { margin: 4px 0 0; color: var(--muted); line-height: 1.55; }
.tag { padding: 5px 8px; border-radius: 999px; background: rgba(255,255,255,.08); color: var(--muted); font-size: 12px; font-weight: 850; }
.plan-card ul { margin: 12px 0 0; padding-left: 18px; color: var(--muted); line-height: 1.55; }
.memo-box { width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 13px; font: inherit; line-height: 1.6; color: var(--ink); background: rgba(255,255,255,.055); }
.memo-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 13px; }
.ghost-button { border: 1px solid var(--line); background: rgba(255,255,255,.055); color: var(--muted); border-radius: 999px; padding: 8px 12px; cursor: pointer; font-weight: 800; }
.theme-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-bottom: 12px; }
.theme-input input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 12px 13px; font: inherit; background: rgba(255,255,255,.055); color: var(--ink); }
.theme-input button { border: 0; border-radius: 8px; padding: 0 16px; background: var(--lime); color: var(--ink-dark); font-weight: 900; cursor: pointer; }
.theme-list { display: grid; gap: 10px; }
.theme-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 13px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.055); }
.theme-card.active { border-color: rgba(217,255,95,.36); background: rgba(217,255,95,.11); }
.theme-card strong { display: block; margin-bottom: 4px; font-size: 15px; }
.theme-card small { color: var(--muted); }
.theme-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.theme-actions button { border: 1px solid var(--line); border-radius: 999px; padding: 7px 10px; background: rgba(255,255,255,.055); color: var(--muted); font-weight: 800; cursor: pointer; }
.theme-actions .primary { border-color: rgba(217,255,95,.25); background: rgba(217,255,95,.14); color: var(--lime); }
.radar-layout { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(170px, .7fr); gap: 12px; align-items: center; }
.radar-layout svg { width: 100%; max-height: 300px; }
.score-row { display: grid; grid-template-columns: 76px 1fr 42px; gap: 8px; align-items: center; font-size: 13px; }
.mini-bar, .progress { overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.1); }
.mini-bar { height: 8px; }
.progress { height: 14px; }
.mini-bar span, .progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--green), var(--lime)); }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
.kpi { padding: 16px; min-height: 126px; }
.kpi .label { color: var(--muted); font-size: 13px; font-weight: 750; }
.kpi .value { margin-top: 8px; font-size: 30px; font-weight: 950; color: var(--ink); }
.kpi .sub { margin-top: 6px; min-height: 34px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.tab { border: 1px solid var(--line); background: rgba(255,255,255,.055); color: var(--muted); border-radius: 999px; padding: 8px 11px; cursor: pointer; font-weight: 750; }
.tab.active { color: var(--ink-dark); border-color: var(--lime); background: var(--lime); }
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
  .hero, .goal-command-panel, .goal-hero-card, .command-grid, .workout-grid, .lower-grid { grid-template-columns: 1fr; }
  .kpis { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
}
@media (max-width: 720px) {
  .shell { width: min(100% - 20px, 1240px); padding-top: 10px; }
  .hero { padding: 20px; min-height: 0; }
  h1 { font-size: 36px; }
  .hero-metrics, .goal-overview-grid, .goal-form, .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-grid, .action-detail-grid { grid-template-columns: 1fr; }
  .radar-layout, .victory-panel { grid-template-columns: 1fr; }
  .theme-input, .theme-card { grid-template-columns: 1fr; }
  .theme-actions { justify-content: flex-start; }
  .section-head { flex-direction: column; }
}
@media (max-width: 520px) {
  .hero-metrics, .goal-overview-grid, .goal-form, .kpis { grid-template-columns: 1fr; }
}`;
}

function dashboardJs() {
  return `const DEFAULT_GOALS = { weightKg: 79, deadline: '2026-07-31', steps: 8000, sleepHours: 6.5, activeEnergyKcal: 650, bodyFatPercent: 25 };
let GOALS = loadGoalSettings();
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
let dashboardData = null;

fetch('./health-data.json')
  .then(res => res.json())
  .then(data => {
    dashboardData = data;
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
  renderGoalManager(latestRecord);
  renderCompletionSummary();
  renderCoaching();
  renderActionDetails();
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
    ['現在体重', metrics.weightKg.format(m.weightKg), kgLeft == null ? targetDeadlineText() : targetDeadlineText() + ' / 残り' + kgLeft.toFixed(1) + 'kg'],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), seven.bodyFatPercent == null ? '7日平均なし' : '7日平均 ' + seven.bodyFatPercent.toFixed(1) + '%'],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), seven.sleepHours == null ? '7日平均なし' : '7日平均 ' + hours(seven.sleepHours)],
  ];
  document.getElementById('heroMetrics').innerHTML = cards.map(([label, value, sub]) =>
    '<div class="hero-card"><span>' + label + '</span><strong>' + value + '</strong><small>' + sub + '</small></div>'
  ).join('');
}

function renderGoalManager(record) {
  const m = record?.metrics || {};
  const weight = m.weightKg;
  const kgLeft = weight == null ? null : round1(weight - GOALS.weightKg);
  const daysLeft = daysUntil(GOALS.deadline);
  const pace = kgLeft == null || daysLeft == null || kgLeft <= 0 ? null : round2(kgLeft / Math.max(1, daysLeft) * 7);
  const progress = weight == null ? 0 : clamp(((84 - weight) / Math.max(.1, 84 - GOALS.weightKg)) * 100, 0, 100);
  document.getElementById('goalOverview').innerHTML =
    '<div class="goal-overview-grid">' +
    '<div class="goal-stat primary"><span>現在</span><strong>' + metrics.weightKg.format(weight) + '</strong><small>目標 ' + GOALS.weightKg.toFixed(1) + 'kg</small></div>' +
    '<div class="goal-stat"><span>残り</span><strong>' + (kgLeft == null ? '-' : Math.max(0, kgLeft).toFixed(1) + 'kg') + '</strong><small>' + targetDeadlineText() + '</small></div>' +
    '<div class="goal-stat"><span>期限</span><strong>' + (daysLeft == null ? '-' : daysLeft + '日') + '</strong><small>' + (pace == null ? '達成後は維持フェーズ' : '週' + pace.toFixed(2) + 'kgペース') + '</small></div>' +
    '<div class="goal-progress"><span style="width:' + progress + '%"></span></div>' +
    '</div>';
  document.getElementById('goalWeightInput').value = GOALS.weightKg;
  document.getElementById('goalDeadlineInput').value = GOALS.deadline;
  document.getElementById('goalStepsInput').value = GOALS.steps;
  document.getElementById('goalSleepInput').value = GOALS.sleepHours;
  document.getElementById('goalBodyFatInput').value = GOALS.bodyFatPercent;
  document.querySelectorAll('.goal-form input').forEach(input => {
    input.oninput = () => { document.getElementById('goalSaveStatus').textContent = '未保存の変更あり'; };
  });
  document.getElementById('saveGoals').onclick = saveGoalsFromInputs;
  document.getElementById('resetGoals').onclick = resetGoals;
}

function renderCompletionSummary() {
  const rate = completionRate();
  const completed = completedCount();
  const total = todayPlan.length;
  const activeTheme = currentThemeText();
  document.getElementById('todayScore').textContent = '今日の指示 ' + completed + '/' + total + ' 完了';
  document.getElementById('motivationLine').textContent = activeTheme || (rate >= 80 ? '最高です。この調子でいこう。' : rate >= 40 ? 'かなり進んでいます。あと少し。' : 'まず1つ押そう。流れができます。');
  document.getElementById('victoryTitle').textContent = rate >= 100 ? '今日の指示 ' + completed + '/' + total + ' 完了。素晴らしいです！' : '今日の指示 ' + completed + '/' + total + ' 完了';
  document.getElementById('completionRing').innerHTML = ringSvg(rate);
}

function renderCoaching() {
  document.getElementById('topPriority').textContent = latestRecord?.coaching?.topPriority || 'データ確認';
  const items = todayPlan.filter(item => item.group === 'today');
  const completed = items.filter(item => dayState.tasks[item.id]).length;
  const total = items.length;
  const allCompleted = completedCount();
  const allTotal = todayPlan.length;
  document.getElementById('coachActions').innerHTML =
    '<div class="summary-grid">' +
    '<div class="summary-card"><span>今日の指示</span><strong>' + completed + '/' + total + '</strong><small>細かい実行内容は下の「実行項目」で管理します。</small></div>' +
    '<div class="summary-card"><span>達成率</span><strong>' + allCompleted + '/' + allTotal + '</strong><small>全タスク合計: ' + completionRate() + '% 完了</small></div>' +
    '<div class="summary-card"><span>次の一手</span><strong>' + nextTaskLabel() + '</strong><small>完了した項目はログへ自動反映されます。</small></div>' +
    '</div>';
}

function renderActionDetails() {
  const items = todayPlan.filter(item => item.group === 'today');
  const done = items.filter(item => dayState.tasks[item.id]).length;
  document.getElementById('actionDetailCount').textContent = done + '/' + items.length + ' 完了';
  document.getElementById('actionDetails').innerHTML = items.length
    ? '<div class="action-detail-grid">' + items.map(item => taskCard(item)).join('') + '</div>'
    : '<div class="status-list"><div class="status-item"><span>実行項目</span><strong>データ更新待ち</strong></div></div>';
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
  document.querySelectorAll('.task-card[data-task-id], .plan-card[data-task-id]').forEach(card => {
    card.onclick = () => toggleTask(card.dataset.taskId);
  });
  document.querySelectorAll('.check-button').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      toggleTask(button.dataset.taskId);
    };
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
  renderActionDetails();
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
  const target = GOALS.weightKg;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / Math.max(.1, start - target)) * 100));
  document.getElementById('weightGoal').innerHTML =
    '<div class="status-list">' +
    '<div class="status-item"><span>現在</span><strong>' + metrics.weightKg.format(weight) + '</strong></div>' +
    '<div class="status-item"><span>目標</span><strong>' + target.toFixed(1) + 'kg</strong></div>' +
    '<div class="status-item"><span>期限</span><strong>' + targetDeadlineText() + '</strong></div>' +
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
function loadGoalSettings() {
  try {
    const raw = localStorage.getItem('dietCoach:goals');
    return raw ? { ...DEFAULT_GOALS, ...JSON.parse(raw) } : { ...DEFAULT_GOALS };
  } catch {
    return { ...DEFAULT_GOALS };
  }
}
function saveGoalsFromInputs() {
  GOALS = {
    weightKg: numberFromInput('goalWeightInput', DEFAULT_GOALS.weightKg),
    deadline: document.getElementById('goalDeadlineInput').value || DEFAULT_GOALS.deadline,
    steps: Math.round(numberFromInput('goalStepsInput', DEFAULT_GOALS.steps)),
    sleepHours: numberFromInput('goalSleepInput', DEFAULT_GOALS.sleepHours),
    activeEnergyKcal: DEFAULT_GOALS.activeEnergyKcal,
    bodyFatPercent: numberFromInput('goalBodyFatInput', DEFAULT_GOALS.bodyFatPercent),
  };
  localStorage.setItem('dietCoach:goals', JSON.stringify(GOALS));
  document.getElementById('goalSaveStatus').textContent = '保存済み';
  todayPlan = buildTodayPlan(latestRecord);
  render(dashboardData || dataPlaceholder());
  showFeedback('目標値を保存して反映しました。');
}
function resetGoals() {
  GOALS = { ...DEFAULT_GOALS };
  localStorage.removeItem('dietCoach:goals');
  document.getElementById('goalSaveStatus').textContent = '初期値に戻しました';
  todayPlan = buildTodayPlan(latestRecord);
  render(dashboardData || dataPlaceholder());
  showFeedback('目標値を初期値に戻しました。');
}
function numberFromInput(id, fallback) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : fallback;
}
function completedCount() { return Object.values(dayState?.tasks || {}).filter(Boolean).length; }
function completionRate() { return todayPlan.length ? Math.round((completedCount() / todayPlan.length) * 100) : 0; }
function nextTaskLabel() {
  const next = todayPlan.find(item => !dayState?.tasks?.[item.id]);
  return next ? next.title : '全部完了';
}
function targetDeadlineText() { return formatDateJa(GOALS.deadline) + 'までに' + GOALS.weightKg.toFixed(1) + 'kg'; }
function daysUntil(isoDate) {
  const target = new Date(isoDate + 'T00:00:00+09:00');
  const now = new Date();
  if (Number.isNaN(target.getTime())) return null;
  return Math.max(0, Math.ceil((target - now) / 86400000));
}
function formatDateJa(isoDate) {
  const date = new Date(isoDate + 'T00:00:00+09:00');
  return Number.isNaN(date.getTime()) ? isoDate : date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}
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
function round1(value) { return Math.round(Number(value) * 10) / 10; }
function round2(value) { return Math.round(Number(value) * 100) / 100; }
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
