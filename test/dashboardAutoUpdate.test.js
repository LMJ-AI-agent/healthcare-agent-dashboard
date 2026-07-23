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
