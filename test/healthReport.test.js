import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addDaysToIsoDate,
  buildPrompt,
  buildVisualHealthReport,
  collectInput,
  evaluateDataReadiness,
  hasPostedForDate,
  markPostedForDate,
  runDailyHealthReport,
} from '../src/healthReport.js';

test('addDaysToIsoDate handles previous day', () => {
  assert.equal(addDaysToIsoDate('2026-06-08', -1), '2026-06-07');
});

test('collectInput reads latest target-date health file and trend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-'));
  const healthDataDir = join(root, 'health');
  const healthPlanetDir = join(root, 'healthplanet');
  const manualNotesDir = join(root, 'notes');
  await mkdir(healthDataDir, { recursive: true });
  await mkdir(healthPlanetDir, { recursive: true });
  await mkdir(manualNotesDir, { recursive: true });

  for (let day = 1; day <= 7; day += 1) {
    const date = `2026-06-0${day}`;
    await writeFile(join(healthDataDir, `${date}.json`), JSON.stringify({
      data: { metrics: [
        { name: 'step_count', data: [{ qty: 1000 * day, date: `${date} 12:00:00 +0900` }] },
        { name: 'active_energy', data: [{ qty: 418.4 * day, date: `${date} 12:00:00 +0900` }] },
        { name: 'weight_body_mass', data: [{ qty: 82 - day * 0.1, date: `${date} 08:00:00 +0900` }] },
        { name: 'body_fat_percentage', data: [{ qty: 28, date: `${date} 08:00:00 +0900` }] },
        { name: 'sleep_analysis', data: [{ totalSleep: 4, sleepStart: `2026-06-0${Math.max(day - 1, 1)} 23:00:00 +0900`, sleepEnd: `${date} 05:00:00 +0900` }] },
      ] },
    }), 'utf8');
  }

  await writeFile(join(healthDataDir, '2026-06-08.json'), JSON.stringify({
    data: { metrics: [
      { name: 'sleep_analysis', data: [{ totalSleep: 6, sleepStart: '2026-06-07 23:00:00 +0900', sleepEnd: '2026-06-08 05:00:00 +0900' }] },
    ] },
  }), 'utf8');
  await writeFile(join(healthPlanetDir, '2026-06-08.json'), JSON.stringify({
    normalized: {
      measuredDate: '2026-06-08',
      heightCm: 162,
      weightKg: 80.8,
      bodyFatPercent: 27.5,
      bodyMassIndex: 30.8,
    },
  }), 'utf8');
  await writeFile(join(manualNotesDir, '2026-06-07.md'), '# note\nworked late', 'utf8');

  const input = await collectInput({
    targetDate: '2026-06-07',
    settings: {
      healthDataDir,
      healthDataDirs: [healthDataDir],
      healthPlanet: { enabled: true, outputDir: healthPlanetDir },
      manualNotesDir,
      manualNotesDirs: [manualNotesDir],
      ringConnExportDir: join(root, 'missing-ring'),
      maxHealthFileBytes: 10000,
      maxManualNoteBytes: 10000,
      maxRingConnBytes: 10000,
    },
  });

  assert.match(input.healthData, /step_count/);
  assert.doesNotMatch(input.healthData, /sleep_analysis/);
  assert.match(input.sleepData, /totalSleep/);
  assert.equal(input.sleepSummary.totalSleepText, '6時間00分');
  assert.equal(input.history.length, 14);
  assert.equal(input.trendSummary.currentSevenDayPeriod.daysWithData, 7);
  assert.equal(input.trendSummary.target.activeEnergyKcal, 700);
  assert.equal(input.bodyCompositionDate, '2026-06-08');
  assert.equal(input.healthPlanet.normalized.weightKg, 80.8);
  assert.equal(input.trendSummary.target.weightKg, 80.8);
  assert.equal(input.trendSummary.differenceFromPreviousDay.activeEnergyKcal, 100);
});

test('collectInput falls back to target-date file when wake-date file has no sleep analysis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-sleep-fallback-'));
  const healthDataDir = join(root, 'health');
  const healthPlanetDir = join(root, 'healthplanet');
  await mkdir(healthDataDir, { recursive: true });
  await mkdir(healthPlanetDir, { recursive: true });

  await writeFile(join(healthDataDir, '2026-06-07.json'), JSON.stringify({
    data: { metrics: [
      { name: 'step_count', data: [{ qty: 3000, source: 'RingConn', date: '2026-06-07 12:00:00 +0900' }] },
      { name: 'active_energy', data: [{ qty: 1200, date: '2026-06-07 12:00:00 +0900' }] },
      { name: 'sleep_analysis', data: [{
        totalSleep: 6.5,
        sleepStart: '2026-06-07 23:30:00 +0900',
        sleepEnd: '2026-06-08 06:30:00 +0900',
        awake: 0.5,
        inBed: 7,
      }] },
    ] },
  }), 'utf8');
  await writeFile(join(healthDataDir, '2026-06-08.json'), JSON.stringify({
    data: { metrics: [
      { name: 'step_count', data: [{ qty: 100, date: '2026-06-08 06:00:00 +0900' }] },
    ] },
  }), 'utf8');
  await writeFile(join(healthPlanetDir, '2026-06-08.json'), JSON.stringify({
    normalized: {
      measuredDate: '2026-06-08',
      heightCm: 162,
      weightKg: 80.8,
      bodyFatPercent: 27.5,
      bodyMassIndex: 30.8,
    },
  }), 'utf8');

  const input = await collectInput({
    targetDate: '2026-06-07',
    settings: {
      healthDataDir,
      healthDataDirs: [healthDataDir],
      healthPlanet: { enabled: true, outputDir: healthPlanetDir },
      manualNotesDir: join(root, 'missing-notes'),
      manualNotesDirs: [join(root, 'missing-notes')],
      ringConnExportDir: join(root, 'missing-ring'),
      maxHealthFileBytes: 10000,
      maxManualNoteBytes: 10000,
      maxRingConnBytes: 10000,
    },
  });

  assert.equal(input.sleepFile.path, join(healthDataDir, '2026-06-07.json'));
  assert.equal(input.sleepSummary.totalSleepText, '6時間30分');
  assert.equal(input.readiness.checks.sleepData, true);
});

test('collectInput rejects late-afternoon RingConn sleep for morning report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-late-sleep-'));
  const healthDataDir = join(root, 'health');
  const healthPlanetDir = join(root, 'healthplanet');
  await mkdir(healthDataDir, { recursive: true });
  await mkdir(healthPlanetDir, { recursive: true });

  await writeFile(join(healthDataDir, '2026-06-20.json'), JSON.stringify({
    data: { metrics: [
      { name: 'step_count', data: [{ qty: 4200, source: 'RingConn', date: '2026-06-20 12:00:00 +0900' }] },
      { name: 'active_energy', data: [{ qty: 2400, date: '2026-06-20 12:00:00 +0900' }] },
    ] },
  }), 'utf8');
  await writeFile(join(healthDataDir, '2026-06-21.json'), JSON.stringify({
    data: { metrics: [
      { name: 'sleep_analysis', data: [{
        totalSleep: 9.583333333333332,
        sleepStart: '2026-06-21 03:11:09 +0900',
        sleepEnd: '2026-06-21 14:58:22 +0900',
        source: 'RingConn',
        awake: 1.2922222222222222,
      }] },
    ] },
  }), 'utf8');
  await writeFile(join(healthPlanetDir, '2026-06-21.json'), JSON.stringify({
    normalized: {
      measuredDate: '2026-06-21',
      heightCm: 162,
      weightKg: 80.8,
      bodyFatPercent: 27.9,
      bodyMassIndex: 30.8,
    },
  }), 'utf8');

  const input = await collectInput({
    targetDate: '2026-06-20',
    settings: {
      healthDataDir,
      healthDataDirs: [healthDataDir],
      healthPlanet: { enabled: true, outputDir: healthPlanetDir },
      manualNotesDir: join(root, 'missing-notes'),
      manualNotesDirs: [join(root, 'missing-notes')],
      ringConnExportDir: join(root, 'missing-ring'),
      maxHealthFileBytes: 10000,
      maxManualNoteBytes: 10000,
      maxRingConnBytes: 10000,
    },
  });

  assert.equal(input.sleepSummary, null);
  assert.equal(input.readiness.checks.sleepData, false);
});

test('evaluateDataReadiness requires health, body composition, and RingConn data; sleep is a warning', () => {
  const ready = evaluateDataReadiness({
    healthFile: { path: 'health.json' },
    healthData: '{"source":"RingConn","steps":1234}',
    sleepFile: { path: 'sleep.json' },
    sleepData: '{"data":{"metrics":[{"name":"sleep_analysis"}]}}',
    sleepSummary: { totalSleepHours: 6 },
    healthPlanet: { normalized: { weightKg: 80.8, bodyFatPercent: 27.5, bodyMassIndex: 30.8 } },
  });
  assert.equal(ready.ready, true);

  const missing = evaluateDataReadiness({
    healthFile: { path: 'health.json' },
    healthData: '{"steps":1234}',
    sleepFile: { path: 'sleep.json' },
    sleepData: '{"data":{"metrics":[{"name":"sleep_analysis"}]}}',
    sleepSummary: null,
    healthPlanet: { normalized: { weightKg: 80.8, bodyFatPercent: null, bodyMassIndex: 30.8 } },
  });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ['bodyComposition', 'ringConnInHealthData']);
  assert.deepEqual(missing.warnings, ['sleepData']);
});

test('evaluateDataReadiness does not block posting when only sleep is missing', () => {
  const readiness = evaluateDataReadiness({
    healthFile: { path: 'health.json' },
    healthData: '{"source":"RingConn","steps":1234}',
    sleepFile: { path: 'sleep.json' },
    sleepData: '{"data":{"metrics":[{"name":"step_count"}]}}',
    sleepSummary: null,
    healthPlanet: { normalized: { weightKg: 80.8, bodyFatPercent: 27.5, bodyMassIndex: 30.8 } },
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missing, []);
  assert.deepEqual(readiness.warnings, ['sleepData']);
});

test('runDailyHealthReport skips posting until required data is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-not-ready-'));
  const healthDataDir = join(root, 'health');
  await mkdir(healthDataDir, { recursive: true });
  await writeFile(join(healthDataDir, '2026-06-07.json'), '{"steps":1234}', 'utf8');

  const result = await runDailyHealthReport({
    targetDate: '2026-06-07',
    noCodex: true,
    skipDashboardPublish: true,
    settings: {
      timeZone: 'Asia/Tokyo',
      healthDataDir,
      healthDataDirs: [healthDataDir],
      manualNotesDir: join(root, 'missing-notes'),
      manualNotesDirs: [join(root, 'missing-notes')],
      ringConnExportDir: join(root, 'missing-ring'),
      outputDir: join(root, 'out'),
      statePath: join(root, 'state.json'),
      maxHealthFileBytes: 10000,
      maxManualNoteBytes: 10000,
      maxRingConnBytes: 10000,
    },
  });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /Data is not ready/);
  assert.deepEqual(result.readiness.missing, ['bodyComposition', 'ringConnInHealthData']);
  assert.deepEqual(result.readiness.warnings, ['sleepData']);
  assert.equal(await hasPostedForDate(join(root, 'state.json'), '2026-06-07'), false);
});

test('buildPrompt includes current report display rules', () => {
  const prompt = buildPrompt({
    targetDate: '2026-06-07',
    healthData: '{"steps":1234}',
    healthFile: { path: 'health.json' },
    sleepDate: '2026-06-08',
    sleepData: '{"data":{"metrics":[{"name":"sleep_analysis","data":[{"totalSleep":6}]}]}}',
    sleepSummary: { totalSleepText: '6時間00分' },
    history: [],
    trendSummary: { periodDaysRequested: 14, currentSevenDayAverage: { steps: 5000, activeEnergyKcal: 400 } },
    healthPlanetTokenStatus: { available: true, remainingDays: 29 },
    manualNotes: [{ path: 'note.md', text: 'worked late' }],
    slackMemos: { available: false, messages: [] },
    ringConn: { snippets: [], note: 'No RingConn export note candidate was found.' },
  });

  assert.ok(prompt.includes('Put today/target-day data first'));
  assert.match(prompt, /Do not include a dedicated previous-day-change section/);
  assert.match(prompt, /Do not mention muscle mass or lean body mass at all/);
  assert.match(prompt, /HealthPlanet API更新まで/);
  assert.match(prompt, /79.0kg/);
  assert.doesNotMatch(prompt, /hooks.slack.com/);
});

test('buildVisualHealthReport renders scannable chart summary', () => {
  const report = buildVisualHealthReport({
    targetDate: '2026-06-25',
    sleepDate: '2026-06-26',
    sleepSummary: { totalSleepHours: 4.4 },
    trendSummary: {
      target: {
        sleepHours: 4.42,
        steps: 8622,
        activeEnergyKcal: 570,
        weightKg: 81.9,
        bodyMassIndex: 31.2,
        bodyFatPercent: 25.4,
      },
      currentSevenDayAverage: {
        sleepHours: 4.92,
        steps: 6723,
        activeEnergyKcal: 568,
        weightKg: 81.3,
        bodyFatPercent: 27.1,
      },
      differenceFromCurrentSevenDayAverage: {
        sleepHours: -0.5,
        steps: 1899,
        activeEnergyKcal: 2,
        weightKg: 0.6,
        bodyFatPercent: -1.7,
      },
      goals: {
        latestWeightKg: 81.9,
        weightTargetKgByJuneEnd: 79,
        kgToTarget: 2.9,
      },
    },
    history: [
      { metrics: { steps: 5000, weightKg: 81.5, bodyFatPercent: 27.5 }, sleep: { totalSleepHours: 5 } },
      { metrics: { steps: 6500, weightKg: 81.4, bodyFatPercent: 27.2 }, sleep: { totalSleepHours: 4.8 } },
      { metrics: { steps: 7000, weightKg: 81.3, bodyFatPercent: 27.0 }, sleep: { totalSleepHours: 5.2 } },
      { metrics: { steps: 8200, weightKg: 81.2, bodyFatPercent: 26.8 }, sleep: { totalSleepHours: 4.9 } },
      { metrics: { steps: 6100, weightKg: 81.0, bodyFatPercent: 26.5 }, sleep: { totalSleepHours: 5.1 } },
      { metrics: { steps: 7600, weightKg: 81.7, bodyFatPercent: 26.0 }, sleep: { totalSleepHours: 4.7 } },
      { metrics: { steps: 8622, weightKg: 81.9, bodyFatPercent: 25.4 }, sleep: { totalSleepHours: 4.42 } },
    ],
    slackMemos: { available: false, messages: [] },
    healthPlanetTokenStatus: { remainingDays: 18 },
  });

  assert.match(report, /Diet Coach Report 2026-06-25/);
  assert.match(report, /今日の主要データ/);
  assert.match(report, /5角形パラメータ/);
  assert.match(report, /今週の筋トレ方針/);
  assert.match(report, /詳細ダッシュボード: https:\/\/lmj-ai-agent\.github\.io\/healthcare-agent-dashboard\//);
  assert.match(report, /HealthPlanet API更新まで: あと18日/);
});

test('posted state prevents duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-state-'));
  const statePath = join(root, 'state.json');
  assert.equal(await hasPostedForDate(statePath, '2026-06-07'), false);
  await markPostedForDate(statePath, '2026-06-07', { artifactDir: 'x' });
  assert.equal(await hasPostedForDate(statePath, '2026-06-07'), true);
});

test('runDailyHealthReport dry-run writes artifacts without codex or slack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-run-'));
  const healthDataDir = join(root, 'health');
  const outputDir = join(root, 'out');
  await mkdir(healthDataDir, { recursive: true });
  await writeFile(join(healthDataDir, '2026-06-07.json'), '{"steps":1234}', 'utf8');

  const result = await runDailyHealthReport({
    targetDate: '2026-06-07',
    dryRun: true,
    noCodex: true,
    settings: {
      timeZone: 'Asia/Tokyo',
      healthDataDir,
      healthDataDirs: [healthDataDir],
      manualNotesDir: join(root, 'missing-notes'),
      manualNotesDirs: [join(root, 'missing-notes')],
      ringConnExportDir: join(root, 'missing-ring'),
      outputDir,
      statePath: join(root, 'state.json'),
      maxHealthFileBytes: 10000,
      maxManualNoteBytes: 10000,
      maxRingConnBytes: 10000,
    },
  });

  assert.equal(result.skipped, false);
  const report = await readFile(join(outputDir, '2026-06-07', 'report.md'), 'utf8');
  assert.match(report, /Diet Coach Report/);
  assert.match(report, /詳細ダッシュボード/);
});

test('runDailyHealthReport skips without health data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'healthcare-agent-missing-'));

  const result = await runDailyHealthReport({
    targetDate: '2026-06-07',
    noCodex: true,
    skipDashboardPublish: true,
    settings: {
      timeZone: 'Asia/Tokyo',
      healthDataDir: join(root, 'missing-health'),
      healthDataDirs: [join(root, 'missing-health')],
      manualNotesDir: join(root, 'missing-notes'),
      manualNotesDirs: [join(root, 'missing-notes')],
      ringConnExportDir: join(root, 'missing-ring'),
      outputDir: join(root, 'out'),
      statePath: join(root, 'state.json'),
      maxHealthFileBytes: 10000,
      maxManualNoteBytes: 10000,
      maxRingConnBytes: 10000,
    },
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /healthData/);
});
