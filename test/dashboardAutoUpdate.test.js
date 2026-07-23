import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard loads fresh health data and exposes dynamic targets', async () => {
  const [html, app] = await Promise.all([
    readFile('docs/index.html', 'utf8'),
    readFile('docs/app.js', 'utf8'),
  ]);

  for (const id of ['currentWeightCounter', 'bodyFatCounter', 'daysToGateCounter', 'weightTrendCanvas', 'recordsTable']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /fetch\('\.\/health-data\.json\?ts=' \+ Date\.now\(\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /chart\.update\(weightSeries\)/);
  assert.match(app, /renderRecords\(records\)/);
});

test('committed health data includes the next and final goals', async () => {
  const data = JSON.parse(await readFile('docs/health-data.json', 'utf8'));
  assert.equal(data.goals.nextWeightKg, 76);
  assert.equal(data.goals.nextDeadline, '2026-10-31');
  assert.equal(data.goals.weightKg, 62);
  assert.ok(Array.isArray(data.records));
  assert.ok(data.records.length > 0);
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
