import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard loads fresh health data and exposes dynamic targets', async () => {
  const [html, app, styles] = await Promise.all([
    readFile('docs/index.html', 'utf8'),
    readFile('docs/app.js', 'utf8'),
    readFile('docs/styles.css', 'utf8'),
  ]);

  for (const id of ['currentWeightCounter', 'bodyFatCounter', 'daysToGateCounter', 'weightTrendCanvas', 'recordMonthTabs', 'recordsMonthSummary', 'recordsTable']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /fetch\('\.\/health-data\.json\?ts=' \+ Date\.now\(\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /chart\.update\(weightSeries\)/);
  assert.match(app, /renderRecords\(records\)/);
  assert.match(app, /selectedRecordMonth/);
  assert.match(app, /previousIsoDate\(record\.date\)/);
  assert.match(app, /updateMovementEquivalents\(weeklyPace, currentWeight\)/);
  assert.match(app, /<span>DATE<\/span><span>WEIGHT<\/span><span>前日比<\/span><span>月初比<\/span><span>STEPS<\/span><span>BODY FAT<\/span>/);
  assert.doesNotMatch(app, /<span>ACTIVE KCAL<\/span>/);
  assert.match(app, /container\.scrollTop = 0/);
  assert.match(styles, /\.records-table \{ max-height: 580px; overflow-y: auto;/);
  assert.match(styles, /\.record-header \{ position: sticky;/);
  assert.match(app, /MONTH CHANGE/);
  assert.match(html, /1日2kmのランニング/);
  assert.match(html, /全減量幅のうち最初の76kgゲートまでが約29パーセント/);
  assert.doesNotMatch(html, /MORNING HABIT/);
  assert.match(html, /<title>RYOTA ISHIJIMA 62 PROJECT \| BODY TRANSFORMATION DASHBOARD<\/title>/);
  assert.match(html, /<strong>RYOTA ISHIJIMA<\/strong><small>62 PROJECT<\/small>/);
  assert.match(html, /62 PROJECT · BODY TRANSFORMATION DASHBOARD · 2026/);
  assert.doesNotMatch(html, /PERSONAL TRANSFORMATION DASHBOARD/);
});

test('committed health data includes the next and final goals', async () => {
  const data = JSON.parse(await readFile('docs/health-data.json', 'utf8'));
  assert.equal(data.goals.nextWeightKg, 76);
  assert.equal(data.goals.nextDeadline, '2026-10-31');
  assert.equal(data.goals.weightKg, 62);
  assert.ok(Array.isArray(data.records));
  assert.ok(data.records.length >= 53);
  assert.equal(data.records[0].date, '2026-06-01');
  assert.ok(data.records.some((record) => record.date === '2026-07-23'));
  assert.equal(new Set(data.records.map((record) => record.date)).size, data.records.length);
});

test('dashboard builder restores daily metrics directly from Health Auto Export JSON', async () => {
  const source = await readFile('scripts/build-dashboard.js', 'utf8');
  assert.match(source, /buildRawHealthByDate\(\)/);
  assert.match(source, /RAW_METRIC_NAMES/);
  assert.match(source, /step_count/);
  assert.match(source, /weight_body_mass/);
  assert.match(source, /body_fat_percentage/);
  assert.match(source, /target\.steps \?\? rawHealth\?\.steps/);
});

test('partial daily data still runs the dashboard publisher', async () => {
  const source = await readFile('src/healthReport.js', 'utf8');
  assert.match(source, /if \(!options\.skipDashboardPublish\) await tryPublishDashboard\(\)/);
});

test('daily task runs once at noon and does not post to Slack', async () => {
  const [source, task] = await Promise.all([
    readFile('src/healthReport.js', 'utf8'),
    readFile('scripts/register-daily-health-report-task.ps1', 'utf8'),
  ]);

  assert.match(source, /arg === '--no-slack'/);
  assert.match(source, /if \(!options\.noSlack\) await postToSlack/);
  assert.match(task, /New-ScheduledTaskTrigger -Daily -At "12:00"/);
  assert.match(task, /--yesterday --no-slack/);
  assert.doesNotMatch(task, /New-ScheduledTaskTrigger -Weekly/);
});

test('Google Analytics loader is wired and enabled with a valid GA4 measurement ID', async () => {
  const [html, config, analytics] = await Promise.all([
    readFile('docs/index.html', 'utf8'),
    readFile('docs/analytics-config.js', 'utf8'),
    readFile('docs/analytics.js', 'utf8'),
  ]);

  assert.match(html, /<script src="\.\/analytics-config\.js"><\/script>/);
  assert.match(html, /<script src="\.\/analytics\.js"><\/script>/);
  assert.match(config, /googleMeasurementId: 'G-[A-Z0-9]+'/);
  assert.match(analytics, /\^G-\[A-Z0-9\]\+\$/i);
  assert.match(analytics, /googletagmanager\.com\/gtag\/js/);
});
