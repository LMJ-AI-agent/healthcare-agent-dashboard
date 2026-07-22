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
    <header class="app-header">
      <a class="brand" href="#top" aria-label="ダイエットダッシュボードの先頭へ">
        <span class="brand-mark">76</span>
        <span><strong>BODY PROJECT</strong><small>Diet coach dashboard</small></span>
      </a>
      <nav class="section-nav" aria-label="ページ内ナビゲーション">
        <a href="#today">今日</a>
        <a href="#roadmap">ロードマップ</a>
        <a href="#trend">推移</a>
        <a href="#records">記録</a>
      </nav>
      <span class="live-badge"><i></i> HEALTH DATA LIVE</span>
    </header>

    <section class="hero" id="top">
      <div class="hero-copy">
        <p class="hero-kicker">PERSONAL TRANSFORMATION / 2026</p>
        <h1 id="campaignTitle">目指せ76.0kg 自己規律改善プロジェクト</h1>
        <div class="goal-lockup">NEXT GOAL <strong id="heroGoalBadge">76.0 KG</strong></div>
        <p class="lead" id="heroLead"></p>
        <div class="hero-actions">
          <span class="streak">2026.10.31までに76kg</span>
          <span class="streak alt">毎朝2km走る習慣をつくる</span>
        </div>
      </div>
      <div class="hero-portrait">
        <img src="./assets/image-2.jpg" alt="自己規律改善プロジェクトのメインビジュアル">
        <span class="photo-scan" aria-hidden="true"></span>
        <div class="hero-scoreboard">
          <p class="scoreboard-label">PROJECT STATUS</p>
          <div id="goalOverview"></div>
        </div>
      </div>
    </section>

    <section class="hero-metrics" id="heroMetrics" aria-label="本日の主要指標"></section>

    <section class="panel roadmap-panel" id="roadmap">
      <div class="roadmap-intro">
        <div>
          <p class="eyebrow">Discipline Roadmap</p>
          <h2>3年後までの自己規律ロードマップ</h2>
        </div>
        <p>2026年7月22日、81.7kgから開始。体重だけでなく、毎朝走ることを当たり前にする。</p>
      </div>
      <div class="roadmap-start">
        <span>START</span>
        <strong>2026.07.22</strong>
        <b>81.7kg</b>
      </div>
      <div class="roadmap-track">
        <article class="roadmap-step current">
          <span class="roadmap-index">01</span>
          <small>3か月後</small>
          <time datetime="2026-10-31">2026.10.31</time>
          <strong>76kg</strong>
          <b>毎朝 2km</b>
          <p>自己規律が改善され、毎朝走る生活を定着させる。</p>
        </article>
        <article class="roadmap-step">
          <span class="roadmap-index">02</span>
          <small>半年後</small>
          <time datetime="2027-01-22">2027.01.22</time>
          <strong>70kg</strong>
          <b>毎朝 4km</b>
          <p>さらに自己規律を高め、朝4kmを継続できる状態にする。</p>
        </article>
        <article class="roadmap-step">
          <span class="roadmap-index">03</span>
          <small>1年後</small>
          <time datetime="2027-07-22">2027.07.22</time>
          <strong>65kg</strong>
          <b>毎朝 5km</b>
          <p>毎朝5kmを生活の基準にし、65kgまで体を整える。</p>
        </article>
        <article class="roadmap-step">
          <span class="roadmap-index">04</span>
          <small>2年後</small>
          <time datetime="2028-07-22">2028.07.22</time>
          <strong>62kg</strong>
          <b>毎朝 5km</b>
          <p>高い自己規律を確立し、62kgの体を完成させる。</p>
        </article>
        <article class="roadmap-step final">
          <span class="roadmap-index">05</span>
          <small>3年後</small>
          <time datetime="2029-07-22">2029.07.22</time>
          <strong>62kg維持</strong>
          <b>毎朝 5km</b>
          <p>高い自己規律を保ち、62kgと朝5kmを維持する。</p>
        </article>
      </div>
    </section>

    <section class="today-layout" id="today">
      <section class="panel command-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Daily Briefing</p>
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
            <h2>コンディション</h2>
          </div>
        </div>
        <div id="radar"></div>
      </section>
    </section>

    <section class="kpis" id="kpis"></section>

    <section class="progress-layout" id="trend">
      <section class="panel chart-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Performance Trend</p>
            <h2>数字で見る変化</h2>
          </div>
          <div class="trend-controls">
            <span class="range-pill">直近90日</span>
            <div class="tabs" id="metricTabs"></div>
          </div>
        </div>
        <div class="forecast-strip" id="weightForecast"></div>
        <div class="chart" id="chart"></div>
      </section>
      <section class="panel campaign-progress-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Race to Goal</p>
            <h2>76kgまでの現在地</h2>
          </div>
          <span class="pill" id="campaignPeriod"></span>
        </div>
        <div id="campaignStats"></div>
      </section>
    </section>

    <section class="panel goal-analysis-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Goal Analysis</p>
          <h2>10月31日までの目標ペース</h2>
        </div>
      </div>
      <div id="weightGoal"></div>
    </section>

    <section class="panel records-panel" id="records">
      <div class="section-head">
        <div>
          <p class="eyebrow">Health Records</p>
          <h2>日別データ</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日付</th>
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
  --page: #eef2f4;
  --paper: #ffffff;
  --ink: #11141a;
  --muted: #68717c;
  --line: #d8dfe3;
  --line-dark: #242932;
  --night: #11151b;
  --coral: #ff593d;
  --lime: #c8f55e;
  --cyan: #39c7d9;
  --blue: #4c6fff;
  --green: #1f9f72;
  --orange: #f29b38;
  --red: #e64b4b;
  --shadow: 0 18px 44px rgba(24, 34, 44, .11);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: "Arial", "Noto Sans JP", ui-sans-serif, system-ui, sans-serif;
  background:
    linear-gradient(90deg, rgba(17,20,26,.035) 1px, transparent 1px),
    linear-gradient(180deg, rgba(17,20,26,.035) 1px, transparent 1px),
    var(--page);
  background-size: 32px 32px, 32px 32px, auto;
  color: var(--ink);
}
.shell { width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 16px 0 48px; }
.app-header {
  min-height: 62px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 28px;
  padding: 0 4px 14px;
}
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; }
.brand-mark { display: grid; place-items: center; width: 42px; height: 42px; background: var(--coral); color: #fff; font-size: 21px; font-weight: 950; transform: skew(-8deg); }
.brand strong, .brand small { display: block; letter-spacing: 0; }
.brand strong { font-size: 14px; }
.brand small { margin-top: 2px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.section-nav { display: flex; justify-content: center; gap: 6px; }
.section-nav a { padding: 9px 12px; color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 850; }
.section-nav a:hover { color: var(--ink); background: #fff; }
.live-badge { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; font-weight: 900; }
.live-badge i { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(31,159,114,.13); }
.hero {
  min-height: 500px;
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(440px, .92fr);
  align-items: stretch;
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--night);
  border-radius: 6px;
  background: var(--night);
  color: #fff;
  box-shadow: var(--shadow);
}
.hero-copy { position: relative; display: flex; flex-direction: column; justify-content: center; padding: 44px 48px 38px; overflow: hidden; }
.hero-copy::after { content: "76"; position: absolute; right: -12px; bottom: -70px; color: rgba(255,255,255,.035); font-size: 300px; font-weight: 950; line-height: 1; pointer-events: none; }
.hero-kicker { margin: 0 0 18px; color: var(--cyan); font-size: 11px; font-weight: 950; letter-spacing: .14em; }
.eyebrow { margin: 0 0 7px; color: var(--muted); font-size: 11px; font-weight: 950; letter-spacing: .12em; text-transform: uppercase; }
h1, h2, h3 { margin: 0; letter-spacing: 0; }
h1 { max-width: 760px; font-size: clamp(38px, 3.8vw, 54px); line-height: 1.08; font-weight: 950; }
h2 { font-size: 22px; font-weight: 950; }
.goal-lockup { display: flex; align-items: baseline; gap: 12px; margin-top: 20px; color: rgba(255,255,255,.48); font-size: 12px; font-weight: 950; letter-spacing: .12em; }
.goal-lockup strong { color: var(--coral); font-size: clamp(34px, 4vw, 58px); letter-spacing: 0; }
.lead { max-width: 720px; margin: 15px 0 0; color: rgba(255,255,255,.6); font-size: 13px; line-height: 1.65; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.streak {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 7px 11px;
  border-radius: 4px;
  background: var(--lime);
  border: 1px solid var(--lime);
  color: var(--night);
  font-size: 12px;
  font-weight: 950;
}
.streak.alt { border-color: rgba(255,255,255,.16); background: transparent; color: rgba(255,255,255,.72); }
.hero-portrait { position: relative; min-height: 500px; overflow: hidden; background: #292f35; }
.hero-portrait img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: center 47%; animation: portrait-drift 12s ease-in-out infinite alternate; }
.photo-scan { position: absolute; top: 0; bottom: 0; left: -4px; width: 3px; background: var(--lime); opacity: .68; box-shadow: 0 0 20px rgba(200,245,94,.6); animation: photo-scan 7s ease-in-out infinite; pointer-events: none; }
.hero-scoreboard { position: absolute; right: 18px; bottom: 18px; left: 18px; padding: 15px; border: 1px solid rgba(255,255,255,.18); background: rgba(17,21,27,.9); backdrop-filter: blur(10px); }
.scoreboard-label { margin: 0 0 10px; color: var(--coral); font-size: 10px; font-weight: 950; letter-spacing: .14em; }
.hero-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line-dark); border-top: 0; background: var(--paper); box-shadow: var(--shadow); }
.hero-card { position: relative; min-height: 120px; padding: 20px; border-right: 1px solid var(--line); background: #fff; animation: rise-in .7s ease both; }
.hero-card:nth-child(2) { animation-delay: .08s; }
.hero-card:nth-child(3) { animation-delay: .16s; }
.hero-card:nth-child(4) { animation-delay: .24s; }
.hero-card:last-child { border-right: 0; }
.hero-card::before { content: ""; position: absolute; left: 20px; top: 0; width: 44px; height: 4px; background: var(--cyan); }
.hero-card:nth-child(2)::before { background: var(--coral); }
.hero-card:nth-child(3)::before { background: var(--blue); }
.hero-card:nth-child(4)::before { background: var(--lime); }
.hero-card span { color: var(--muted); font-size: 11px; font-weight: 900; }
.hero-card strong { display: block; margin-top: 10px; color: var(--ink); font-size: 28px; line-height: 1; }
.hero-card small { display: block; margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.roadmap-panel { position: relative; overflow: hidden; padding: 0; }
.roadmap-panel::before { content: ""; position: absolute; left: 0; top: 0; width: 8px; height: 100%; background: var(--coral); }
.roadmap-intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .65fr); gap: 28px; align-items: end; padding: 26px 30px 22px; border-bottom: 1px solid var(--line); }
.roadmap-intro p:last-child { max-width: 540px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
.roadmap-start { display: flex; align-items: baseline; gap: 14px; padding: 15px 30px; color: #fff; background: var(--night); }
.roadmap-start span { color: var(--cyan); font-size: 10px; font-weight: 950; letter-spacing: .14em; }
.roadmap-start strong { font-size: 15px; }
.roadmap-start b { margin-left: auto; color: var(--lime); font-size: 22px; }
.roadmap-track { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
.roadmap-step { position: relative; min-height: 260px; padding: 24px 20px 22px; border-right: 1px solid var(--line); animation: rise-in .65s ease both; }
.roadmap-step:nth-child(2) { animation-delay: .08s; }
.roadmap-step:nth-child(3) { animation-delay: .16s; }
.roadmap-step:nth-child(4) { animation-delay: .24s; }
.roadmap-step:nth-child(5) { animation-delay: .32s; }
.roadmap-step:last-child { border-right: 0; }
.roadmap-step::before { content: ""; position: absolute; left: 20px; top: 0; width: 40px; height: 4px; background: var(--cyan); }
.roadmap-step.current::before { background: var(--coral); }
.roadmap-step.final::before { background: var(--lime); }
.roadmap-index { display: block; color: #cbd3d8; font-size: 34px; font-weight: 950; line-height: 1; }
.roadmap-step small { display: block; margin-top: 18px; color: var(--coral); font-size: 11px; font-weight: 950; }
.roadmap-step time { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
.roadmap-step strong { display: block; margin-top: 12px; font-size: 30px; line-height: 1; }
.roadmap-step b { display: inline-block; margin-top: 12px; padding: 6px 8px; color: #fff; background: var(--blue); font-size: 12px; }
.roadmap-step p { margin: 14px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.panel, .kpi {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  box-shadow: 0 12px 34px rgba(24,34,44,.07);
}
.panel { padding: 22px; margin-top: 16px; }
.section-note { margin: 10px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.today-layout { display: grid; grid-template-columns: minmax(520px, 1.25fr) minmax(400px, .75fr); gap: 14px; }
.victory-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px;
  gap: 18px;
  align-items: center;
  position: relative;
  overflow: hidden;
  background: var(--coral);
  border-color: var(--coral);
  color: #fff;
}
.victory-panel .eyebrow, .victory-panel .section-note { color: rgba(255,255,255,.74); }
.completion-ring { width: 110px; height: 110px; }
.toast {
  position: absolute;
  left: 22px;
  bottom: 18px;
  opacity: 0;
  transform: translateY(8px);
  transition: .25s ease;
  padding: 10px 13px;
  border-radius: 4px;
  color: var(--night);
  background: var(--lime);
  font-size: 12px;
  font-weight: 950;
}
.toast.show { opacity: 1; transform: translateY(0); }
.goal-overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; align-items: stretch; background: rgba(255,255,255,.14); }
.goal-stat { min-height: 136px; padding: 18px 14px; background: #181d24; }
.goal-stat.primary { background: var(--lime); color: var(--night); }
.goal-stat span { display: block; color: inherit; opacity: .62; font-size: 10px; font-weight: 950; text-transform: uppercase; }
.goal-stat strong { display: block; margin-top: 12px; font-size: 34px; line-height: 1; }
.goal-stat small { display: block; margin-top: 11px; color: inherit; opacity: .67; font-size: 11px; line-height: 1.45; }
.goal-progress { grid-column: 1 / -1; height: 10px; overflow: hidden; background: rgba(255,255,255,.09); }
.goal-progress span { display: block; height: 100%; background: var(--coral); }
.goal-settings-panel { padding: 0; overflow: hidden; }
.goal-settings-panel summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 22px; cursor: pointer; list-style: none; }
.goal-settings-panel summary::-webkit-details-marker { display: none; }
.goal-settings-panel summary small, .goal-settings-panel summary strong { display: block; }
.goal-settings-panel summary small { margin-bottom: 4px; color: var(--muted); font-size: 10px; font-weight: 950; letter-spacing: .12em; }
.goal-settings-panel summary strong { font-size: 17px; }
.goal-settings-body { padding: 0 22px 22px; border-top: 1px solid var(--line); }
.goal-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding-top: 18px; }
.goal-form label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 850; }
.goal-form input {
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 9px 11px;
  background: #f7f9fa;
  color: var(--ink);
  font: inherit;
}
.goal-buttons { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.primary-button { border: 0; border-radius: 4px; padding: 10px 14px; background: var(--night); color: #fff; font-weight: 950; cursor: pointer; }
.progress-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(420px, .65fr); gap: 14px; }
.trend-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
.range-pill { display: inline-flex; align-items: center; min-height: 33px; padding: 7px 10px; border-radius: 4px; color: var(--night); background: var(--lime); font-size: 11px; font-weight: 950; white-space: nowrap; }
.forecast-strip { display: grid; grid-template-columns: minmax(190px, 1.1fr) repeat(3, minmax(120px, .75fr)); gap: 1px; margin-bottom: 14px; border: 1px solid var(--line-dark); background: var(--line-dark); overflow: hidden; }
.forecast-block { min-height: 96px; padding: 14px; background: #f7f9fa; }
.forecast-block.primary { color: #fff; background: var(--night); }
.forecast-block.alert { color: var(--night); background: var(--coral); }
.forecast-block span { display: block; color: inherit; opacity: .62; font-size: 10px; font-weight: 950; letter-spacing: .06em; }
.forecast-block strong { display: block; margin-top: 8px; font-size: 26px; line-height: 1; }
.forecast-block small { display: block; margin-top: 7px; color: inherit; opacity: .68; font-size: 10px; line-height: 1.4; }
.campaign-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.campaign-stat {
  min-height: 114px;
  padding: 15px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #f7f9fa;
}
.campaign-stat.featured { color: #fff; background: var(--night); border-color: var(--night); }
.campaign-stat span { display: block; color: inherit; opacity: .62; font-size: 11px; font-weight: 900; }
.campaign-stat strong { display: block; margin-top: 10px; font-size: 28px; line-height: 1; }
.campaign-stat small { display: block; margin-top: 9px; color: inherit; opacity: .7; font-size: 11px; line-height: 1.45; }
.milestone-panel table td:last-child, .milestone-panel table th:last-child { text-align: center; }
.workout-grid, .lower-grid, .planning-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.training-panel { border-top: 6px solid var(--blue); }
.diet-panel { border-top: 6px solid var(--green); }
.category-chip { display: inline-flex; align-items: center; min-height: 28px; padding: 5px 9px; border-radius: 3px; font-size: 10px; font-weight: 950; letter-spacing: .08em; }
.strength-chip { color: #fff; background: var(--blue); }
.diet-chip { color: #fff; background: var(--green); }
.section-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.pill { display: inline-flex; align-items: center; min-height: 29px; padding: 6px 9px; border-radius: 3px; background: #eff4f5; color: var(--muted); border: 1px solid var(--line); font-size: 11px; font-weight: 900; white-space: nowrap; }
.task-list, .plan-stack, .status-list, .score-list { display: grid; gap: 10px; }
.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.summary-card { min-height: 112px; padding: 15px; border: 1px solid var(--line); border-radius: 4px; background: #f7f9fa; }
.summary-card span { display: block; color: var(--muted); font-size: 12px; font-weight: 800; }
.summary-card strong { display: block; margin-top: 8px; font-size: 30px; line-height: 1; }
.summary-card small { display: block; margin-top: 8px; color: var(--muted); line-height: 1.45; }
.action-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.task-card, .plan-card {
  position: relative;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #f8fafb;
  cursor: pointer;
  transition: transform .18s ease, border-color .18s ease, background .18s ease;
}
.task-card:hover, .plan-card:hover { transform: translateY(-2px); border-color: #aeb9c1; }
.task-card.done, .plan-card.done { border-color: #9dc63f; background: #f2fbdc; }
.task-row, .plan-card .top { display: grid; grid-template-columns: 42px 1fr auto; gap: 12px; align-items: center; }
.check-button {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 2px solid #bdc7cd;
  background: #fff;
  color: var(--muted);
  cursor: pointer;
  font-size: 19px;
  font-weight: 950;
}
.done .check-button { color: var(--night); background: var(--lime); border-color: #9fc639; }
.inline-memo { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.task-card strong, .plan-card h3 { display: block; font-size: 15px; }
.task-card p { margin: 4px 0 0; color: var(--muted); line-height: 1.55; }
.tag { padding: 5px 8px; border-radius: 3px; background: #e9eef1; color: var(--muted); font-size: 11px; font-weight: 850; }
.done .tag { background: var(--lime); color: var(--night); }
.plan-card ul { margin: 12px 0 0; padding-left: 18px; color: var(--muted); line-height: 1.55; }
.memo-box { width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: 4px; padding: 13px; font: inherit; line-height: 1.6; color: var(--ink); background: #f8fafb; }
.memo-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 13px; }
.ghost-button { border: 1px solid var(--line); background: #fff; color: var(--muted); border-radius: 4px; padding: 8px 12px; cursor: pointer; font-weight: 800; }
.theme-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-bottom: 12px; }
.theme-input input { width: 100%; border: 1px solid var(--line); border-radius: 4px; padding: 12px 13px; font: inherit; background: #f8fafb; color: var(--ink); }
.theme-input button { border: 0; border-radius: 4px; padding: 0 16px; background: var(--night); color: #fff; font-weight: 900; cursor: pointer; }
.theme-list { display: grid; gap: 10px; }
.theme-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 13px; border: 1px solid var(--line); border-radius: 4px; background: #f8fafb; }
.theme-card.active { border-color: #9dc63f; background: #f2fbdc; }
.theme-card strong { display: block; margin-bottom: 4px; font-size: 15px; }
.theme-card small { color: var(--muted); }
.theme-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.theme-actions button { border: 1px solid var(--line); border-radius: 4px; padding: 7px 10px; background: #fff; color: var(--muted); font-weight: 800; cursor: pointer; }
.theme-actions .primary { border-color: var(--night); background: var(--night); color: #fff; }
.radar-layout { display: grid; grid-template-columns: minmax(170px, 1fr) minmax(128px, .62fr); gap: 10px; align-items: center; }
.radar-layout svg { width: 100%; max-height: 300px; }
.score-row { display: grid; grid-template-columns: 54px 1fr 32px; gap: 6px; align-items: center; font-size: 12px; }
.mini-bar, .progress { overflow: hidden; border-radius: 2px; background: #e5eaed; }
.mini-bar { height: 8px; }
.progress { height: 14px; }
.mini-bar span, .progress span { display: block; height: 100%; background: var(--green); }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
.kpi { position: relative; padding: 16px; min-height: 126px; overflow: hidden; }
.kpi::after { content: ""; position: absolute; right: 0; top: 0; width: 5px; height: 100%; background: var(--cyan); }
.kpi:nth-child(2)::after { background: var(--coral); }
.kpi:nth-child(3)::after { background: var(--blue); }
.kpi:nth-child(4)::after { background: var(--green); }
.kpi:nth-child(5)::after { background: var(--orange); }
.kpi .label { color: var(--muted); font-size: 13px; font-weight: 750; }
.kpi .value { margin-top: 8px; font-size: 30px; font-weight: 950; color: var(--ink); }
.kpi .sub { margin-top: 6px; min-height: 34px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.tab { border: 1px solid var(--line); background: #fff; color: var(--muted); border-radius: 4px; padding: 8px 10px; cursor: pointer; font-weight: 800; }
.tab.active { color: #fff; border-color: var(--night); background: var(--night); }
.chart { min-height: 310px; }
.chart svg { width: 100%; height: 310px; display: block; }
.chart-line { stroke-dasharray: 1800; stroke-dashoffset: 1800; animation: draw-chart 1.8s cubic-bezier(.2,.8,.2,1) forwards; }
.chart-area { opacity: 0; animation: fade-chart .9s ease .55s forwards; }
.chart-point { transform-box: fill-box; transform-origin: center; animation: point-pop .35s ease both; }
.status-item { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.status-item span { color: var(--muted); }
.ok { color: var(--green); }
.warn { color: var(--orange); }
.bad { color: var(--red); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 11px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; }
th:first-child, td:first-child { text-align: left; }
@keyframes portrait-drift { from { transform: scale(1.01); } to { transform: scale(1.06) translateY(-8px); } }
@keyframes photo-scan { 0%, 12% { left: -4px; opacity: 0; } 24%, 72% { opacity: .68; } 88%, 100% { left: calc(100% + 4px); opacity: 0; } }
@keyframes rise-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes draw-chart { to { stroke-dashoffset: 0; } }
@keyframes fade-chart { to { opacity: .11; } }
@keyframes point-pop { from { opacity: 0; transform: scale(.35); } to { opacity: 1; transform: scale(1); } }
@media (max-width: 1180px) {
  .hero, .today-layout, .progress-layout { grid-template-columns: 1fr; }
  .hero-portrait { min-height: 560px; }
  .goal-form { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .radar-layout { grid-template-columns: minmax(220px, .8fr) 1fr; }
  .roadmap-track { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .roadmap-step { border-bottom: 1px solid var(--line); }
  .campaign-stat-grid, .kpis { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
}
@media (max-width: 720px) {
  .shell { width: min(100% - 20px, 1240px); padding-top: 10px; }
  .app-header { grid-template-columns: 1fr auto; }
  .section-nav { display: none; }
  .live-badge { font-size: 0; }
  .hero { min-height: 0; }
  .hero-copy { padding: 30px 22px; }
  .hero-copy::after { font-size: 200px; }
  .hero-portrait { min-height: 520px; }
  .hero-scoreboard { right: 10px; bottom: 10px; left: 10px; padding: 11px; }
  h1 { font-size: 40px; }
  .hero-metrics, .goal-overview-grid, .goal-form, .campaign-stat-grid, .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hero-card:nth-child(2) { border-right: 0; }
  .hero-card:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .workout-grid, .lower-grid, .planning-grid { grid-template-columns: 1fr; }
  .roadmap-intro { grid-template-columns: 1fr; padding: 22px; }
  .roadmap-start { padding: 14px 22px; }
  .roadmap-track { grid-template-columns: 1fr; }
  .roadmap-step { min-height: 0; border-right: 0; }
  .summary-grid, .action-detail-grid { grid-template-columns: 1fr; }
  .forecast-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trend-controls { justify-content: flex-start; }
  .radar-layout { grid-template-columns: 1fr; }
  .theme-input, .theme-card { grid-template-columns: 1fr; }
  .theme-actions { justify-content: flex-start; }
  .section-head { flex-direction: column; }
}
@media (max-width: 520px) {
  .goal-overview-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .goal-stat { min-height: 112px; padding: 14px 9px; }
  .goal-stat strong { font-size: 24px; }
  .goal-stat small { font-size: 9px; }
  .hero-metrics, .goal-form, .campaign-stat-grid, .kpis { grid-template-columns: 1fr; }
  .hero-card { border-right: 0; border-bottom: 1px solid var(--line); }
  .victory-panel { grid-template-columns: minmax(0, 1fr) 90px; }
  .completion-ring { width: 90px; height: 90px; }
  .panel { padding: 17px; }
  .task-row { grid-template-columns: 38px minmax(0, 1fr); }
  .tag { grid-column: 2; width: max-content; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}`;
}

function dashboardJs() {
  return `const DEFAULT_GOALS = { startWeightKg: 81.7, startDate: '2026-07-22', weightKg: 76, deadline: '2026-10-31', steps: 8000, sleepHours: 6.5, activeEnergyKcal: 650, bodyFatPercent: 25 };
let GOALS = { ...DEFAULT_GOALS };
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
    ? '更新: ' + new Date(data.generatedAt).toLocaleString('ja-JP') + ' / ' + data.recordCount + '日分。最初の到達点は2026年10月31日の76kgと毎朝2km。'
    : '';
  renderHeroMetrics(latestRecord, kgLeft);
  renderGoalManager(latestRecord);
  renderCampaignProgress(latestRecord);
  renderCoaching();
  renderRadar(latestRecord);
  renderKpis(latestRecord);
  renderTabs();
  renderWeightForecast();
  renderChart();
  renderWeightGoal(latestRecord);
  renderTable();
  requestAnimationFrame(animateCounters);
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
  const cards = [
    ['現在体重', metrics.weightKg.format(m.weightKg), kgLeft == null ? targetDeadlineText() : '76kgまであと' + Math.max(0, kgLeft).toFixed(1) + 'kg'],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), seven.bodyFatPercent == null ? '7日平均なし' : '7日平均 ' + seven.bodyFatPercent.toFixed(1) + '%'],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), seven.sleepHours == null ? '7日平均なし' : '7日平均 ' + hours(seven.sleepHours)],
    ['歩数', metrics.steps.format(m.steps), seven.steps == null ? '7日平均なし' : '7日平均 ' + Math.round(seven.steps).toLocaleString('ja-JP') + '歩'],
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
  const progress = weight == null ? 0 : clamp(((GOALS.startWeightKg - weight) / Math.max(.1, GOALS.startWeightKg - GOALS.weightKg)) * 100, 0, 100);
  document.getElementById('goalOverview').innerHTML =
    '<div class="goal-overview-grid">' +
    '<div class="goal-stat primary"><span>現在</span>' + counterStrong(weight, 1, 'kg') + '<small>目標 ' + GOALS.weightKg.toFixed(1) + 'kg</small></div>' +
    '<div class="goal-stat"><span>残り</span>' + counterStrong(kgLeft == null ? null : Math.max(0, kgLeft), 1, 'kg') + '<small>' + targetDeadlineText() + '</small></div>' +
    '<div class="goal-stat"><span>期限</span>' + counterStrong(daysLeft, 0, '日') + '<small>' + (pace == null ? '達成後は維持フェーズ' : '週' + pace.toFixed(2) + 'kgペース') + '</small></div>' +
    '<div class="goal-progress"><span style="width:' + progress + '%"></span></div>' +
    '</div>';
}

function renderCampaignProgress(record) {
  const current = record?.metrics?.weightKg;
  const start = GOALS.startWeightKg;
  const target = GOALS.weightKg;
  const totalDays = dateDiffDays(GOALS.startDate, GOALS.deadline);
  const elapsedDays = Math.min(totalDays ?? 0, Math.max(0, dateDiffDays(GOALS.startDate, todayIso()) ?? 0));
  const daysLeft = daysUntil(GOALS.deadline);
  const reduced = current == null ? null : round1(start - current);
  const remaining = current == null ? null : round1(current - target);
  const requiredPace = current == null || daysLeft == null || daysLeft <= 0 ? null : round3(Math.max(0, current - target) / daysLeft);
  const currentPace = current == null || elapsedDays <= 0 ? null : round3(Math.max(0, start - current) / elapsedDays);
  const expected = expectedWeightForDate(todayIso());
  const delay = current == null || expected == null ? null : round1(current - expected);
  document.getElementById('campaignTitle').textContent = '目指せ' + target.toFixed(1) + 'kg 自己規律改善プロジェクト';
  document.getElementById('heroGoalBadge').textContent = target.toFixed(1) + ' KG';
  document.getElementById('campaignPeriod').textContent = formatDateJa(GOALS.startDate) + ' - ' + formatDateJa(GOALS.deadline);
  const paceStatus = requiredPace == null || currentPace == null
    ? 'データ待ち'
    : currentPace >= requiredPace ? '予定以上' : '要ペースアップ';
  const delayText = delay == null
    ? '目標ペース比較なし'
    : delay <= 0 ? '目標ペースより' + Math.abs(delay).toFixed(1) + 'kg先行' : '目標ペースより' + delay.toFixed(1) + 'kg遅れ';
  const cards = [
    ['現在体重', metrics.weightKg.format(current), latestRecord?.date ? latestRecord.date + ' 時点 / ' + delayText : delayText],
    ['減量済み', reduced == null ? '-' : reduced.toFixed(1) + 'kg', 'START ' + start.toFixed(1) + 'kg'],
    ['ゴールまで残り', remaining == null ? '-' : Math.max(0, remaining).toFixed(1) + 'kg', 'GOAL ' + target.toFixed(1) + 'kg'],
    ['残り日数', daysLeft == null ? '-' : daysLeft + '日', totalDays ? '全' + totalDays + '日中 ' + elapsedDays + '日経過' : '期間未設定'],
    ['必要ペース', requiredPace == null ? '-' : requiredPace.toFixed(3) + 'kg/日', '今日から期限まで'],
    ['現状ペース', currentPace == null ? '-' : currentPace.toFixed(3) + 'kg/日', paceStatus],
  ];
  document.getElementById('campaignStats').innerHTML =
    '<div class="campaign-stat-grid">' + cards.map(([label, value, sub], index) =>
      '<div class="campaign-stat ' + (index === 0 ? 'featured' : '') + '"><span>' + label + '</span><strong>' + value + '</strong><small>' + sub + '</small></div>'
    ).join('') + '</div>';
}

function renderMilestones() {
  const rows = buildMilestones();
  document.getElementById('milestones').innerHTML =
    '<div class="table-wrap"><table><thead><tr><th>月</th><th>目標</th><th>実績</th><th>状況</th></tr></thead><tbody>' +
    rows.map(row => '<tr><td>' + row.month + '</td><td>' + row.target + '</td><td>' + row.actual + '</td><td><span class="' + row.className + '">' + row.status + '</span></td></tr>').join('') +
    '</tbody></table></div>';
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
  const weight = latestRecord?.metrics?.weightKg;
  const remaining = weight == null ? null : Math.max(0, weight - GOALS.weightKg);
  document.getElementById('coachActions').innerHTML =
    '<div class="summary-grid">' +
    '<div class="summary-card"><span>今日の最優先</span><strong>' + escapeHtml(latestRecord?.coaching?.topPriority || 'データ確認') + '</strong><small>健康データを基準に、今日いちばん重要なこと。</small></div>' +
    '<div class="summary-card"><span>3か月後</span><strong>76kg</strong><small>2026年10月31日まで。現在から' + (remaining == null ? '-' : remaining.toFixed(1) + 'kg') + '。</small></div>' +
    '<div class="summary-card"><span>朝の習慣</span><strong>2km</strong><small>毎朝走ることを、最初の自己規律の基準にする。</small></div>' +
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
  const seven = record?.coaching?.sevenDay || {};
  const stepHabit = clamp(((seven.steps ?? 0) / GOALS.steps) * 100, 0, 100);
  const sleepHabit = clamp(((seven.sleepHours ?? 0) / GOALS.sleepHours) * 100, 0, 100);
  return [
    { label: '減量', score: clamp(100 - Math.max(0, (m.weightKg ?? 84) - GOALS.weightKg) * 12, 0, 100) },
    { label: '活動', score: clamp(((m.steps ?? 0) / GOALS.steps) * 100, 0, 100) },
    { label: '睡眠', score: clamp(((m.sleepHours ?? 0) / GOALS.sleepHours) * 100, 0, 100) },
    { label: '体脂肪', score: clamp(100 - Math.max(0, (m.bodyFatPercent ?? 32) - GOALS.bodyFatPercent) * 9, 0, 100) },
    { label: '習慣', score: (stepHabit + sleepHabit) / 2 },
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

function renderWeightForecast() {
  const forecast = buildWeightForecast();
  const host = document.getElementById('weightForecast');
  if (!forecast) {
    host.innerHTML = '<div class="forecast-block primary"><span>ネクストゴール時の予測</span><strong>-</strong><small>体重記録が5件以上になると表示</small></div>';
    return;
  }
  const gap = round1(forecast.predictedKg - GOALS.weightKg);
  const monthly = round1(forecast.dailySlope * 30);
  const gapClass = gap > 0 ? ' alert' : '';
  const trendLabel = monthly > 0 ? '+' + monthly.toFixed(1) : monthly.toFixed(1);
  host.innerHTML =
    '<div class="forecast-block primary"><span>ネクストゴール時の予測</span>' + counterStrong(forecast.predictedKg, 1, 'kg') + '<small>' + formatDateJa(GOALS.deadline) + ' 時点</small></div>' +
    '<div class="forecast-block"><span>ネクストゴール</span>' + counterStrong(GOALS.weightKg, 1, 'kg') + '<small>毎朝2kmを習慣化</small></div>' +
    '<div class="forecast-block' + gapClass + '"><span>予測と目標の差</span>' + counterStrong(Math.abs(gap), 1, 'kg') + '<small>' + (gap > 0 ? '目標より上振れ' : '目標達成圏内') + '</small></div>' +
    '<div class="forecast-block"><span>現状トレンド</span><strong>' + trendLabel + 'kg/月</strong><small>直近30日・' + forecast.sampleCount + '件から推定</small></div>';
}

function buildWeightForecast() {
  const weightRows = records.filter(r => r.metrics?.weightKg != null);
  const latest = weightRows.at(-1);
  if (!latest) return null;
  const cutoff = shiftIsoDate(latest.date, -29);
  const sample = weightRows.filter(r => r.date >= cutoff && r.date <= latest.date);
  if (sample.length < 5) return null;
  const baseMs = Date.parse(sample[0].date + 'T00:00:00Z');
  const points = sample.map(r => ({ x: (Date.parse(r.date + 'T00:00:00Z') - baseMs) / 86400000, y: Number(r.metrics.weightKg) }));
  const slopes = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dayGap = points[j].x - points[i].x;
      if (dayGap > 0) slopes.push((points[j].y - points[i].y) / dayGap);
    }
  }
  if (!slopes.length) return null;
  const dailySlope = clamp(median(slopes), -0.05, 0.05);
  const intercept = median(points.map(point => point.y - dailySlope * point.x));
  const goalX = (Date.parse(GOALS.deadline + 'T00:00:00Z') - baseMs) / 86400000;
  const predictedKg = clamp(intercept + dailySlope * goalX, 40, 180);
  return { predictedKg: round1(predictedKg), dailySlope, sampleCount: sample.length };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderChart() {
  const meta = metrics[selectedMetric];
  const anchorDate = latestRecord?.date || todayIso();
  const cutoffDate = shiftIsoDate(anchorDate, -89);
  const rows = records.filter(r => r.date >= cutoffDate && r.date <= anchorDate && r.metrics?.[selectedMetric] != null);
  const values = rows.map(r => r.metrics[selectedMetric]);
  const targetValues = selectedMetric === 'weightKg' ? rows.map(r => expectedWeightForDate(r.date)).filter(v => v != null) : [];
  const chart = document.getElementById('chart');
  if (!values.length) { chart.innerHTML = '<p class="bad">この項目のデータがありません</p>'; return; }
  const min = Math.min(...values, ...targetValues), max = Math.max(...values, ...targetValues);
  const pad = max === min ? 1 : (max - min) * 0.15;
  const lo = min - pad, hi = max + pad;
  const width = 940, height = 310, left = 56, right = 20, top = 22, bottom = 44;
  const rangeStartMs = Date.parse(cutoffDate + 'T00:00:00Z');
  const rangeEndMs = Date.parse(anchorDate + 'T00:00:00Z');
  const x = isoDate => left + ((Date.parse(isoDate + 'T00:00:00Z') - rangeStartMs) / Math.max(1, rangeEndMs - rangeStartMs)) * (width - left - right);
  const y = v => top + (hi - v) * ((height - top - bottom) / Math.max(1, hi - lo));
  const points = rows.map(r => [x(r.date), y(r.metrics[selectedMetric]), r]);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const targetPoints = selectedMetric === 'weightKg'
    ? rows.map(r => [x(r.date), expectedWeightForDate(r.date)]).filter(([, v]) => v != null).map(([px, v, r]) => [px, y(v), r])
    : [];
  const targetPath = targetPoints.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = path + ' L' + points.at(-1)[0].toFixed(1) + ',' + (height - bottom) + ' L' + points[0][0].toFixed(1) + ',' + (height - bottom) + ' Z';
  const labels = Array.from({ length: 6 }, (_, index) => {
    const ratio = index / 5;
    const tickMs = rangeStartMs + (rangeEndMs - rangeStartMs) * ratio;
    const tickDate = new Date(tickMs).toISOString().slice(0, 10);
    const tickX = left + ratio * (width - left - right);
    return '<line x1="' + tickX + '" y1="' + top + '" x2="' + tickX + '" y2="' + (height - bottom) + '" stroke="#e8ecef" stroke-dasharray="3 6"/><text x="' + tickX + '" y="' + (height - 13) + '" text-anchor="middle" font-size="11" fill="#66736d">' + tickDate.slice(5) + '</text>';
  }).join('');
  chart.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + meta.label + ' chart">' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<line x1="' + left + '" y1="' + (height - bottom) + '" x2="' + (width - right) + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<path class="chart-area" d="' + area + '" fill="' + meta.color + '"/>' +
    (targetPath ? '<path d="' + targetPath + '" fill="none" stroke="#ff593d" stroke-width="2.5" stroke-dasharray="8 7"/><text x="' + (width - right - 126) + '" y="' + (top + 18) + '" font-size="12" font-weight="800" fill="#ff593d">目標ペース</text>' : '') +
    '<path class="chart-line" d="' + path + '" fill="none" stroke="' + meta.color + '" stroke-width="3.5"/>' +
    points.map(([cx, cy, r], index) => '<circle class="chart-point" style="animation-delay:' + Math.min(.8, index * .025).toFixed(2) + 's" cx="' + cx + '" cy="' + cy + '" r="4.5" fill="#fff" stroke="' + meta.color + '" stroke-width="3"><title>' + r.date + ': ' + meta.format(r.metrics[selectedMetric]) + '</title></circle>').join('') +
    '<text x="8" y="' + (top + 6) + '" font-size="11" fill="#66736d">' + meta.format(max) + '</text>' +
    '<text x="8" y="' + (height - bottom) + '" font-size="11" fill="#66736d">' + meta.format(min) + '</text>' + labels + '</svg>';
}

function renderWeightGoal(record) {
  const weight = record?.metrics?.weightKg;
  const target = GOALS.weightKg;
  const start = Math.max(weight || target, GOALS.startWeightKg);
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
    return '<tr><td>' + r.date + '</td><td>' + metrics.sleepHours.format(r.metrics.sleepHours) + '</td><td>' + metrics.steps.format(r.metrics.steps) + '</td><td>' + metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal) + '</td><td>' + metrics.weightKg.format(r.metrics.weightKg) + '</td><td>' + metrics.bodyFatPercent.format(r.metrics.bodyFatPercent) + '</td><td>' + (r.metrics.bodyMassIndex == null ? '-' : r.metrics.bodyMassIndex.toFixed(1)) + '</td></tr>';
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
    startWeightKg: numberFromInput('goalStartWeightInput', DEFAULT_GOALS.startWeightKg),
    startDate: document.getElementById('goalStartDateInput').value || DEFAULT_GOALS.startDate,
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
function buildMilestones() {
  const rows = [];
  const start = new Date(GOALS.startDate + 'T00:00:00+09:00');
  const end = new Date(GOALS.deadline + 'T00:00:00+09:00');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return rows;
  let cursor = new Date(start);
  cursor.setDate(1);
  const latest = latestRecord?.date || todayIso();
  while (cursor <= end) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const periodStartIso = isoFromDate(monthStart < start ? start : monthStart);
    const periodEndIso = isoFromDate(monthEnd > end ? end : monthEnd);
    const targetStart = expectedWeightForDate(periodStartIso);
    const targetEnd = expectedWeightForDate(periodEndIso);
    const actual = latestWeightOnOrBefore(periodEndIso);
    const isPast = periodEndIso < latest;
    const isCurrent = periodStartIso <= latest && latest <= periodEndIso;
    const achieved = actual != null && targetEnd != null && actual <= targetEnd;
    rows.push({
      month: String(cursor.getMonth() + 1) + '月',
      target: targetStart == null || targetEnd == null ? '-' : targetStart.toFixed(1) + 'kg → ' + targetEnd.toFixed(1) + 'kg',
      actual: actual == null ? '-' : actual.toFixed(1) + 'kg',
      status: achieved ? '達成' : isCurrent ? '進行中' : isPast ? '未達' : '予定',
      className: achieved ? 'ok' : isCurrent ? 'warn' : isPast ? 'bad' : '',
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return rows;
}
function latestWeightOnOrBefore(isoDate) {
  const row = [...records].reverse().find(r => r.date <= isoDate && r.metrics?.weightKg != null);
  return row?.metrics?.weightKg ?? null;
}
function expectedWeightForDate(isoDate) {
  const total = dateDiffDays(GOALS.startDate, GOALS.deadline);
  const elapsed = dateDiffDays(GOALS.startDate, isoDate);
  if (total == null || elapsed == null || total <= 0) return null;
  const ratio = clamp(elapsed / total, 0, 1);
  return round2(GOALS.startWeightKg + (GOALS.weightKg - GOALS.startWeightKg) * ratio);
}
function completedCount() { return Object.values(dayState?.tasks || {}).filter(Boolean).length; }
function completionRate() { return todayPlan.length ? Math.round((completedCount() / todayPlan.length) * 100) : 0; }
function nextTaskLabel() {
  const next = todayPlan.find(item => !dayState?.tasks?.[item.id]);
  return next ? next.title : '全部完了';
}
function targetDeadlineText() { return formatDateJa(GOALS.deadline) + 'までに' + GOALS.weightKg.toFixed(1) + 'kg'; }
function dateDiffDays(startIso, endIso) {
  const start = new Date(startIso + 'T00:00:00+09:00');
  const end = new Date(endIso + 'T00:00:00+09:00');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.round((end - start) / 86400000));
}
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
  return '<svg viewBox="0 0 138 138"><circle cx="69" cy="69" r="' + r + '" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="13"/><circle cx="69" cy="69" r="' + r + '" fill="none" stroke="#c8f55e" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 69 69)"/><text x="69" y="65" text-anchor="middle" font-size="28" font-weight="900" fill="#ffffff">' + rate + '%</text><text x="69" y="88" text-anchor="middle" font-size="12" font-weight="800" fill="rgba(255,255,255,.78)">完了</text></svg>';
}
function dataPlaceholder() { return { generatedAt: new Date().toISOString(), recordCount: records.length }; }
function point(cx, cy, r, index, total) { const angle = -Math.PI / 2 + index * 2 * Math.PI / total; return [Math.round((cx + Math.cos(angle) * r) * 10) / 10, Math.round((cy + Math.sin(angle) * r) * 10) / 10]; }
function goalText(value, target, unit) { if (value == null) return '目標 ' + target + unit; const diff = value - target; return diff <= 0 ? '目標達成' : '目標まであと' + diff.toFixed(1) + unit; }
function targetText(value, target, unit) { if (value == null) return '目標 ' + target.toLocaleString('ja-JP') + unit; const diff = value - target; return diff >= 0 ? '目標比 +' + Math.round(diff).toLocaleString('ja-JP') + unit : '目標まで ' + Math.abs(Math.round(diff)).toLocaleString('ja-JP') + unit; }
function deltaText(value, unit) { if (value == null) return '前回比データなし'; const sign = value > 0 ? '+' : ''; if (unit === 'h') return '前回比 ' + sign + value.toFixed(2) + '時間'; return '前回比 ' + sign + value.toFixed(unit === '%' ? 1 : 0) + unit; }
function hasAnyMetric(record) { return record && Object.values(record.metrics || {}).some(v => v != null); }
function hours(value) { if (value == null || !Number.isFinite(Number(value))) return '-'; const mins = Math.round(Number(value) * 60); return Math.floor(mins / 60) + '時間' + String(mins % 60).padStart(2, '0') + '分'; }
function todayIso() { return isoFromDate(new Date()); }
function isoFromDate(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
function shiftIsoDate(isoDate, dayOffset) {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}
function counterStrong(value, decimals, suffix) {
  if (value == null || !Number.isFinite(Number(value))) return '<strong>-</strong>';
  const number = Number(value);
  return '<strong class="count-up" data-count="' + number + '" data-decimals="' + decimals + '" data-suffix="' + suffix + '">' + formatCounter(number, decimals, suffix) + '</strong>';
}
function animateCounters() {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.count-up').forEach((element, index) => {
    if (element.dataset.animated === 'true') return;
    element.dataset.animated = 'true';
    const target = Number(element.dataset.count);
    const decimals = Number(element.dataset.decimals || 0);
    const suffix = element.dataset.suffix || '';
    if (reducedMotion || !Number.isFinite(target)) {
      element.textContent = formatCounter(target, decimals, suffix);
      return;
    }
    const duration = 850 + index * 90;
    const startedAt = performance.now();
    const tick = now => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatCounter(target * eased, decimals, suffix);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
function formatCounter(value, decimals, suffix) {
  return Number(value).toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function round1(value) { return Math.round(Number(value) * 10) / 10; }
function round2(value) { return Math.round(Number(value) * 100) / 100; }
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
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
