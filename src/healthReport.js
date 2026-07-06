import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAndSaveHealthPlanetDay, mergeHealthPlanetMetrics, readHealthPlanetDay, readHealthPlanetTokenStatus } from './healthPlanet.js';

const TEXT_EXTENSIONS = new Set(['.json', '.csv', '.txt', '.md']);
const RINGCONN_KEYWORD_PATTERN = /note|notes|tag|tags|timeline|mood|stress|alcohol|meal|exercise|sleep|health|memo|diary|body|condition|drink|food|workout|ノート|メモ|タグ|タイムライン|気分|ストレス|飲酒|食事|運動|睡眠|体調/i;

export async function readSettings(path = 'config/settings.json') {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

export function isoDateInTimeZone(date = new Date(), timeZone = 'Asia/Tokyo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDaysToIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function yesterdayIsoDateInTimeZone(date = new Date(), timeZone = 'Asia/Tokyo') {
  return addDaysToIsoDate(isoDateInTimeZone(date, timeZone), -1);
}

export async function collectInput({ targetDate, settings }) {
  const healthDataDirs = settings.healthDataDirs || [settings.healthDataDir];
  const sleepDate = addDaysToIsoDate(targetDate, 1);
  const bodyCompositionDate = sleepDate;
  const [healthFile, manualNotes, ringConn] = await Promise.all([
    findLatestHealthFile(healthDataDirs, targetDate),
    readManualNotes(settings.manualNotesDirs || [settings.manualNotesDir], [targetDate, sleepDate], settings.maxManualNoteBytes),
    inspectRingConnExports(settings.ringConnExportDir, targetDate, settings.maxRingConnBytes),
  ]);
  const sleepContext = await findSleepContext(healthDataDirs, targetDate, sleepDate);
  const slackMemos = await readSlackMemos({ settings, targetDate, sleepDate });
  const healthPlanet = await readHealthPlanetDay(settings, bodyCompositionDate);
  const healthPlanetTokenStatus = await readHealthPlanetTokenStatus(settings);
  const history = await buildHistorySummary({
    dirs: healthDataDirs,
    settings,
    targetDate,
    days: settings.historyDays || 14,
  });
  const trendSummary = buildTrendSummary(history, targetDate);

  const rawHealthData = healthFile
    ? await readLimitedText(healthFile.path, settings.maxHealthFileBytes)
    : null;
  const healthData = rawHealthData ? removeSleepAnalysisMetric(rawHealthData) : null;
  const sleepFile = sleepContext?.file || null;
  const sleepData = sleepContext?.data || null;
  const sleepSummary = sleepContext?.summary || null;
  const readiness = evaluateDataReadiness({
    healthFile,
    healthData,
    sleepFile,
    sleepData,
    sleepSummary,
    healthPlanet,
  });

  return { targetDate, sleepDate, bodyCompositionDate, healthFile, healthData, sleepFile, sleepData, sleepSummary, history, trendSummary, healthPlanet, healthPlanetTokenStatus, manualNotes, slackMemos, ringConn, readiness };
}

export function evaluateDataReadiness({ healthFile, healthData, sleepFile, sleepData, sleepSummary, healthPlanet }) {
  const checks = {
    healthData: Boolean(healthFile && healthData),
    sleepData: Boolean(sleepFile && sleepData && sleepSummary?.totalSleepHours),
    bodyComposition: Boolean(
      healthPlanet?.normalized?.weightKg != null
      && healthPlanet?.normalized?.bodyFatPercent != null
      && healthPlanet?.normalized?.bodyMassIndex != null,
    ),
    ringConnInHealthData: containsRingConnData(healthData) || containsRingConnData(sleepData),
  };
  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    missing: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
  };
}

export async function readSlackMemos({ settings, targetDate, sleepDate }) {
  if (!settings.slackMemoChannelId || !settings.slackBotTokenFile) {
    return { available: false, reason: 'Slack memo channel or token file is not configured.', messages: [] };
  }

  let token;
  try {
    token = (await readFile(settings.slackBotTokenFile, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { available: false, reason: 'Slack bot token file was not found.', messages: [] };
    }
    throw error;
  }
  if (!token) {
    return { available: false, reason: 'Slack bot token file is empty.', messages: [] };
  }

  const oldest = toSlackTs(`${targetDate}T${padHour(settings.slackMemoWindowStartHour ?? 18)}:00:00+09:00`);
  const latest = toSlackTs(`${sleepDate}T${padHour(settings.slackMemoWindowEndHour ?? 8)}:00:00+09:00`);
  const messages = [];
  try {
    const response = await slackApi('conversations.history', token, {
      channel: settings.slackMemoChannelId,
      oldest,
      latest,
      inclusive: true,
      limit: 200,
    });

    for (const message of response.messages || []) {
      await appendSlackMemoMessage({ messages, message, token });
      if (message.reply_count > 0) {
        const replies = await slackApi('conversations.replies', token, {
          channel: settings.slackMemoChannelId,
          ts: message.ts,
          oldest,
          latest,
          inclusive: true,
          limit: 200,
        });
        for (const reply of replies.messages || []) {
          if (reply.ts !== message.ts) {
            await appendSlackMemoMessage({ messages, message: reply, token, threadTs: message.ts });
          }
        }
      }
    }
  } catch (error) {
    return {
      available: false,
      reason: `Slack memo fetch failed: ${error.message}`,
      window: { oldest, latest },
      messages,
    };
  }

  return {
    available: messages.length > 0,
    window: { oldest, latest },
    messages,
  };
}

async function appendSlackMemoMessage({ messages, message, token, threadTs = null }) {
  if (!isUserSlackMemo(message)) return;
  const text = cleanSlackText(message.text || '');
  const files = await Promise.all((message.files || []).map((file) => describeSlackFile({ file, token })));
  if (!text && files.length === 0) return;
  messages.push({
    ts: message.ts,
    threadTs,
    text,
    files,
  });
}

function isUserSlackMemo(message) {
  if (!message.user) return false;
  if (message.bot_id || message.app_id) return false;
  if (!message.subtype) return true;
  return message.subtype === 'file_share';
}

function padHour(hour) {
  return String(Number(hour)).padStart(2, '0');
}

function toSlackTs(isoWithOffset) {
  return String(new Date(isoWithOffset).getTime() / 1000);
}

async function slackApi(method, token, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error || 'unknown_error'}`);
  }
  return data;
}

async function describeSlackFile({ file, token }) {
  let detailed = file;
  try {
    const info = await slackApi('files.info', token, { file: file.id });
    detailed = info.file || file;
  } catch {
    detailed = file;
  }

  return {
    id: detailed.id,
    name: detailed.name,
    title: detailed.title,
    mimetype: detailed.mimetype,
    filetype: detailed.filetype,
    transcription: extractSlackTranscription(detailed),
  };
}

function extractSlackTranscription(file) {
  const candidates = [
    file.transcription,
    file.transcript,
    file.transcription_text,
    file.plain_text,
    file.preview_plain_text,
    file.preview,
  ].filter((value) => typeof value === 'string' && value.trim());
  return candidates[0] || null;
}

function cleanSlackText(text) {
  return String(text).replace(/<@[^>]+>/g, '').trim();
}

async function findLatestHealthFile(dirs, targetDate) {
  const files = (await Promise.all(
    dirs.filter(Boolean).map((dir) => listFilesSafe(dir)),
  )).flat();
  const datePattern = new RegExp(targetDate.replaceAll('-', '[-_/]?'));
  const candidates = [];

  for (const path of files) {
    const extension = extname(path).toLowerCase();
    if (extension !== '.json' && extension !== '.csv') continue;
    if (hasMultipleDateTokens(path)) continue;
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EPERM' || error.code === 'EACCES') continue;
      throw error;
    }
    candidates.push({
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      dateMatches: datePattern.test(path),
    });
  }

  const matchingCandidates = candidates.filter((candidate) => candidate.dateMatches);
  if (matchingCandidates.length === 0) return null;
  matchingCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matchingCandidates[0] || null;
}

function hasMultipleDateTokens(path) {
  const matches = basename(path).match(/\d{4}[-_]\d{2}[-_]\d{2}/g) || [];
  return new Set(matches.map((value) => value.replaceAll('_', '-'))).size > 1;
}

async function readManualNotes(dirs, dates, maxBytes) {
  const paths = dirs.flatMap((dir) => dates.flatMap((date) => [
    join(dir, `${date}.md`),
    join(dir, `${date}.json`),
    join(dir, `${date}.txt`),
  ]));
  const notes = [];
  let remaining = maxBytes;

  for (const path of paths) {
    if (remaining <= 0) break;
    try {
      const text = await readLimitedText(path, remaining);
      notes.push({ path, text });
      remaining -= Buffer.byteLength(text, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }
  }
  return notes;
}

async function inspectRingConnExports(dir, targetDate, maxBytes) {
  const files = await listFilesSafe(dir);
  const datePattern = new RegExp(targetDate.replaceAll('-', '[-_/]?'));
  const snippets = [];
  let remaining = maxBytes;

  for (const path of files.filter((item) => TEXT_EXTENSIONS.has(extname(item).toLowerCase()))) {
    if (remaining <= 0) break;
    const nameMatches = RINGCONN_KEYWORD_PATTERN.test(path) || datePattern.test(path);
    let raw;
    try {
      raw = await readLimitedText(path, Math.min(remaining, 40_000));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EPERM' || error.code === 'EACCES') continue;
      throw error;
    }
    const contentMatches = RINGCONN_KEYWORD_PATTERN.test(raw) || datePattern.test(raw);
    if (!nameMatches && !contentMatches) continue;
    const text = truncate(raw, Math.min(remaining, 40_000));
    snippets.push({ path, text });
    remaining -= Buffer.byteLength(text, 'utf8');
  }

  return {
    available: snippets.length > 0,
    snippets,
    note: snippets.length > 0
      ? 'RingConn export candidate files were found.'
      : 'No RingConn export note candidate was found.',
  };
}

async function listFilesSafe(dir) {
  try {
    return await listFiles(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EPERM') return [];
    throw error;
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFiles(path));
    } else if (entry.isFile()) {
      results.push(path);
    }
  }
  return results;
}

async function readLimitedText(path, maxBytes) {
  const buffer = await readFile(path);
  return truncate(buffer.toString('utf8'), maxBytes);
}

function removeSleepAnalysisMetric(text) {
  try {
    const json = JSON.parse(text);
    const metrics = json?.data?.metrics;
    if (!Array.isArray(metrics)) return text;
    json.data.metrics = metrics.filter((metric) => metric?.name !== 'sleep_analysis');
    return JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}

async function extractSleepAnalysisMetric(path) {
  try {
    const text = await readFile(path, 'utf8');
    const json = JSON.parse(text);
    const sleepMetric = json?.data?.metrics?.find((metric) => metric?.name === 'sleep_analysis');
    if (!sleepMetric) return null;
    return JSON.stringify({ data: { metrics: [sleepMetric] } }, null, 2);
  } catch {
    return null;
  }
}

async function findSleepContext(dirs, targetDate, wakeDate) {
  const files = await uniqueFiles([
    await findLatestHealthFile(dirs, wakeDate),
    await findLatestHealthFile(dirs, targetDate),
  ]);
  const fallback = [];

  for (const file of files) {
    const data = await extractSleepAnalysisMetric(file.path);
    const summary = summarizeSleepData(data, wakeDate);
    if (!data || !summary) continue;
    if (summary.sleepEnd && isoDateInTimeZone(parseAppleHealthDate(summary.sleepEnd), 'Asia/Tokyo') === wakeDate) {
      return { file, data, summary };
    }
    fallback.push({ file, data, summary });
  }

  return fallback[0] || { file: files[0] || null, data: null, summary: null };
}

async function uniqueFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    if (!file?.path || seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function summarizeSleepData(sleepData, wakeDate = null) {
  if (!sleepData) return null;
  try {
    const json = JSON.parse(sleepData);
    const samples = json?.data?.metrics?.[0]?.data || [];
    const sample = selectMainSleepSample(samples, wakeDate);
    if (!sample) return null;
    return {
      sleepStart: sample.sleepStart,
      sleepEnd: sample.sleepEnd,
      totalSleepHours: sample.effectiveSleepHours,
      totalSleepText: formatHours(sample.effectiveSleepHours),
      rawTotalSleepHours: sample.totalSleep,
      elapsedHours: sample.elapsedHours,
      inBedText: formatHours(sample.effectiveInBedHours),
      awakeText: formatHours(sample.awake),
      remText: formatHours(sample.rem),
      deepText: formatHours(sample.deep),
      coreText: formatHours(sample.core),
    };
  } catch {
    return null;
  }
}

function selectMainSleepSample(samples, wakeDate = null) {
  const valid = samples
    .filter((sample) => Number.isFinite(Number(sample?.totalSleep)))
    .map((sample) => ({
      ...sample,
      totalSleepNumber: Number(sample.totalSleep),
      startDate: parseAppleHealthDate(sample.sleepStart),
      endDate: parseAppleHealthDate(sample.sleepEnd),
    }))
    .map((sample) => ({
      ...sample,
      elapsedHours: hoursBetween(sample.startDate, sample.endDate),
    }))
    .map((sample) => ({
      ...sample,
      effectiveSleepHours: effectiveSleepHours(sample),
      effectiveInBedHours: effectiveInBedHours(sample),
    }))
    .filter((sample) => sample.effectiveSleepHours > 0);
  if (valid.length === 0) return null;

  const wakeMatches = wakeDate
    ? valid.filter((sample) => isoDateInTimeZone(sample.endDate, 'Asia/Tokyo') === wakeDate)
    : valid;
  const morningWakeMatches = wakeMatches.filter((sample) => {
    const endHour = hourInTimeZone(sample.endDate, 'Asia/Tokyo');
    return endHour != null && endHour >= 0 && endHour <= 12;
  });
  const pool = wakeDate
    ? morningWakeMatches
    : valid;
  if (pool.length === 0) return null;
  const nightSleeps = pool.filter((sample) => {
    const startHour = hourInTimeZone(sample.startDate, 'Asia/Tokyo');
    const duration = sample.effectiveSleepHours;
    const isNightLike = startHour == null || startHour >= 18 || startHour <= 6;
    return duration >= 2 && duration <= 12 && isNightLike;
  });
  const candidates = nightSleeps.length > 0 ? nightSleeps : pool;
  candidates.sort((a, b) => b.effectiveSleepHours - a.effectiveSleepHours);
  return candidates[0];
}

function hourInTimeZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(date));
}

function effectiveSleepHours(sample) {
  const total = Number(sample.totalSleepNumber);
  const elapsed = Number(sample.elapsedHours);
  const awake = Number(sample.awake);
  if (Number.isFinite(elapsed) && elapsed > 0 && total > elapsed + 0.25) {
    if (Number.isFinite(awake) && awake >= 0 && awake < elapsed) return round(elapsed - awake, 4);
    return round(elapsed, 4);
  }
  return total;
}

function effectiveInBedHours(sample) {
  const inBed = Number(sample.inBed);
  const elapsed = Number(sample.elapsedHours);
  if (Number.isFinite(elapsed) && elapsed > 0 && (!Number.isFinite(inBed) || inBed > elapsed + 0.25)) {
    return round(elapsed, 4);
  }
  return Number.isFinite(inBed) ? inBed : elapsed;
}

function hoursBetween(startDate, endDate) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) return null;
  const diffMs = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;
  return diffMs / 3_600_000;
}

function parseAppleHealthDate(value) {
  if (!value) return null;
  const normalized = String(value).replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const totalMinutes = Math.round(number * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return String(minutes) + '\u5206';
  return String(hours) + '\u6642\u9593' + String(minutes).padStart(2, '0') + '\u5206';
}

async function buildHistorySummary({ dirs, settings, targetDate, days }) {
  const rows = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDaysToIsoDate(targetDate, -offset);
    const file = await findLatestHealthFile(dirs, date);
    const wakeDate = addDaysToIsoDate(date, 1);
    const sleepContext = await findSleepContext(dirs, date, wakeDate);
    const bodyCompositionDate = wakeDate;
    const healthPlanet = await readHealthPlanetDay(settings, bodyCompositionDate);
    const metrics = mergeHealthPlanetMetrics(
      file ? await summarizeHealthFile(file.path) : null,
      healthPlanet?.normalized,
    );
    rows.push({ date, file: file?.path || null, sleepFile: sleepContext?.file?.path || null, healthPlanetDate: bodyCompositionDate, healthPlanetFile: healthPlanet?.path || null, metrics, sleep: sleepContext?.summary || null });
  }
  return rows;
}

function buildTrendSummary(history, targetDate) {
  const rows = history.filter((row) => row.metrics || row.sleep);
  const target = rows.find((row) => row.date === targetDate) || rows.at(-1) || null;
  const previousDay = rows.find((row) => row.date === addDaysToIsoDate(targetDate, -1)) || null;
  const currentSevenRows = rows.slice(-7);
  const previousSevenRows = rows.slice(-14, -7);
  const priorRollingSevenRows = rows.slice(-8, -1);
  const targetMetrics = target?.metrics || {};
  const targetSleep = target?.sleep || {};
  const previousMetrics = previousDay?.metrics || {};
  const previousSleep = previousDay?.sleep || {};
  const currentAverage = averageRows(currentSevenRows);
  const previousAverage = averageRows(previousSevenRows);
  const priorRollingAverage = averageRows(priorRollingSevenRows);
  const latestWeightKg = latestMetric(rows, (row) => row.metrics?.weightKg);

  return {
    periodDaysRequested: history.length,
    periodDaysWithData: rows.length,
    periodStart: rows[0]?.date || null,
    periodEnd: rows.at(-1)?.date || null,
    targetDate,
    currentSevenDayPeriod: periodForRows(currentSevenRows),
    previousSevenDayPeriod: periodForRows(previousSevenRows),
    priorRollingSevenDayPeriod: periodForRows(priorRollingSevenRows),
    target: {
      steps: targetMetrics.steps ?? null,
      distanceKm: targetMetrics.distanceKm ?? null,
      activeEnergyKcal: targetMetrics.activeEnergyKcal ?? null,
      activeEnergyKj: targetMetrics.activeEnergyKj ?? null,
      sleepHours: targetSleep.totalSleepHours ?? null,
      sleepText: targetSleep.totalSleepText ?? null,
      restingHeartRate: targetMetrics.restingHeartRate ?? null,
      weightKg: targetMetrics.weightKg ?? null,
      bodyMassIndex: targetMetrics.bodyMassIndex ?? null,
      bodyFatPercent: targetMetrics.bodyFatPercent ?? null,
      leanBodyMassKg: targetMetrics.leanBodyMassKg ?? null,
      muscleMassKg: targetMetrics.muscleMassKg ?? null,
    },
    previousDay: {
      date: previousDay?.date || null,
      steps: previousMetrics.steps ?? null,
      distanceKm: previousMetrics.distanceKm ?? null,
      activeEnergyKcal: previousMetrics.activeEnergyKcal ?? null,
      sleepHours: previousSleep.totalSleepHours ?? null,
      sleepText: previousSleep.totalSleepText ?? null,
    },
    differenceFromPreviousDay: {
      steps: diff(targetMetrics.steps, previousMetrics.steps, 0),
      distanceKm: diff(targetMetrics.distanceKm, previousMetrics.distanceKm, 2),
      activeEnergyKcal: diff(targetMetrics.activeEnergyKcal, previousMetrics.activeEnergyKcal, 0),
      sleepHours: diff(targetSleep.totalSleepHours, previousSleep.totalSleepHours, 2),
    },
    currentSevenDayAverage: currentAverage,
    previousSevenDayAverage: previousAverage,
    priorRollingSevenDayAverage: priorRollingAverage,
    differenceFromCurrentSevenDayAverage: diffMetrics({
      steps: targetMetrics.steps,
      distanceKm: targetMetrics.distanceKm,
      activeEnergyKcal: targetMetrics.activeEnergyKcal,
      sleepHours: targetSleep.totalSleepHours,
      restingHeartRate: targetMetrics.restingHeartRate,
      weightKg: targetMetrics.weightKg,
      bodyFatPercent: targetMetrics.bodyFatPercent,
    }, currentAverage),
    currentSevenVsPreviousSeven: diffMetrics(currentAverage, previousAverage),
    currentSevenVsPriorRollingSeven: diffMetrics(currentAverage, priorRollingAverage),
    healthDirection: buildHealthDirection({
      currentAverage,
      previousAverage,
      priorRollingAverage,
      latestWeightKg,
    }),
    goals: {
      heightCm: 162,
      weightTargetKgByJuneEnd: 79,
      latestWeightKg,
      kgToTarget: diff(latestWeightKg, 79, 1),
      recommendedPace: '1kg per 2 weeks; 5% body weight per 30 days is the upper-limit guide',
      businessPurpose: 'Improve health stability so work output and sales performance improve',
    },
  };
}

function averageRows(rows) {
  return {
    steps: averageMetric(rows, (row) => row.metrics?.steps),
    distanceKm: averageMetric(rows, (row) => row.metrics?.distanceKm),
    activeEnergyKcal: averageMetric(rows, (row) => row.metrics?.activeEnergyKcal),
    sleepHours: averageMetric(rows, (row) => row.sleep?.totalSleepHours),
    restingHeartRate: averageMetric(rows, (row) => row.metrics?.restingHeartRate),
    weightKg: averageMetric(rows, (row) => row.metrics?.weightKg),
    bodyMassIndex: averageMetric(rows, (row) => row.metrics?.bodyMassIndex),
    bodyFatPercent: averageMetric(rows, (row) => row.metrics?.bodyFatPercent),
    leanBodyMassKg: averageMetric(rows, (row) => row.metrics?.leanBodyMassKg),
    muscleMassKg: averageMetric(rows, (row) => row.metrics?.muscleMassKg),
  };
}

function periodForRows(rows) {
  return {
    daysWithData: rows.filter((row) => row.metrics || row.sleep).length,
    start: rows[0]?.date || null,
    end: rows.at(-1)?.date || null,
  };
}

function diffMetrics(value, baseline) {
  return {
    steps: diff(value?.steps, baseline?.steps, 0),
    distanceKm: diff(value?.distanceKm, baseline?.distanceKm, 2),
    activeEnergyKcal: diff(value?.activeEnergyKcal, baseline?.activeEnergyKcal, 0),
    sleepHours: diff(value?.sleepHours, baseline?.sleepHours, 2),
    restingHeartRate: diff(value?.restingHeartRate, baseline?.restingHeartRate, 1),
    weightKg: diff(value?.weightKg, baseline?.weightKg, 1),
    bodyMassIndex: diff(value?.bodyMassIndex, baseline?.bodyMassIndex, 1),
    bodyFatPercent: diff(value?.bodyFatPercent, baseline?.bodyFatPercent, 1),
    leanBodyMassKg: diff(value?.leanBodyMassKg, baseline?.leanBodyMassKg, 1),
    muscleMassKg: diff(value?.muscleMassKg, baseline?.muscleMassKg, 1),
  };
}

function buildHealthDirection({ currentAverage, previousAverage, priorRollingAverage, latestWeightKg }) {
  return {
    comparedWithPreviousWeek: {
      sleep: direction(diff(currentAverage.sleepHours, previousAverage.sleepHours, 2), 'higherIsBetter'),
      steps: direction(diff(currentAverage.steps, previousAverage.steps, 0), 'higherIsBetter'),
      activeEnergy: direction(diff(currentAverage.activeEnergyKcal, previousAverage.activeEnergyKcal, 0), 'higherIsBetter'),
      restingHeartRate: direction(diff(currentAverage.restingHeartRate, previousAverage.restingHeartRate, 1), 'lowerIsBetter'),
      weightToward79kg: direction(diff(distanceToTarget(currentAverage.weightKg, 79), distanceToTarget(previousAverage.weightKg, 79), 1), 'lowerIsBetter'),
      bodyFat: direction(diff(currentAverage.bodyFatPercent, previousAverage.bodyFatPercent, 1), 'lowerIsBetter'),
    },
    comparedWithPriorRollingSevenDays: {
      sleep: direction(diff(currentAverage.sleepHours, priorRollingAverage.sleepHours, 2), 'higherIsBetter'),
      steps: direction(diff(currentAverage.steps, priorRollingAverage.steps, 0), 'higherIsBetter'),
      activeEnergy: direction(diff(currentAverage.activeEnergyKcal, priorRollingAverage.activeEnergyKcal, 0), 'higherIsBetter'),
      restingHeartRate: direction(diff(currentAverage.restingHeartRate, priorRollingAverage.restingHeartRate, 1), 'lowerIsBetter'),
      weightToward79kg: direction(diff(distanceToTarget(currentAverage.weightKg, 79), distanceToTarget(priorRollingAverage.weightKg, 79), 1), 'lowerIsBetter'),
      bodyFat: direction(diff(currentAverage.bodyFatPercent, priorRollingAverage.bodyFatPercent, 1), 'lowerIsBetter'),
    },
    latestWeightKg,
  };
}

function direction(delta, mode) {
  if (delta == null) return { delta: null, healthImpact: 'unknown' };
  if (delta === 0) return { delta, healthImpact: 'neutral' };
  const positive = mode === 'higherIsBetter' ? delta > 0 : delta < 0;
  return { delta, healthImpact: positive ? 'plus' : 'minus' };
}

function distanceToTarget(value, target) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.abs(Number(value) - target);
}

function averageMetric(rows, picker, digits = 2) {
  const values = rows.map(picker).filter((value) => value != null && Number.isFinite(Number(value)));
  if (values.length === 0) return null;
  return round(values.reduce((total, value) => total + Number(value), 0) / values.length, digits);
}

function latestMetric(rows, picker) {
  return rows.toReversed().map(picker).find((value) => value != null && Number.isFinite(Number(value))) ?? null;
}

async function summarizeHealthFile(path) {
  try {
    const json = JSON.parse(await readFile(path, 'utf8'));
    const metrics = json?.data?.metrics || [];
    return {
      steps: sumMetric(metrics, 'step_count'),
      distanceKm: round(sumMetric(metrics, 'walking_running_distance'), 2),
      activeEnergyKj: round(sumMetric(metrics, 'active_energy'), 1),
      activeEnergyKcal: round(kjToKcal(sumMetric(metrics, 'active_energy')), 0),
      restingHeartRate: round(avgMetric(metrics, 'resting_heart_rate'), 1),
      heartRateAvg: round(avgMetric(metrics, 'heart_rate'), 1),
      heartRateMax: round(maxMetric(metrics, 'heart_rate'), 1),
      spo2Avg: round(avgMetric(metrics, 'blood_oxygen_saturation'), 1),
      weightKg: round(lastMetric(metrics, 'weight_body_mass'), 1),
      bodyMassIndex: round(lastMetric(metrics, 'body_mass_index'), 1),
      bodyFatPercent: round(lastMetric(metrics, 'body_fat_percentage'), 1),
      leanBodyMassKg: round(firstAvailableLastMetric(metrics, ['lean_body_mass', 'lean_body_mass_kg']), 1),
      muscleMassKg: round(firstAvailableLastMetric(metrics, ['muscle_mass', 'skeletal_muscle_mass', 'body_muscle_mass']), 1),
    };
  } catch {
    return null;
  }
}

function firstAvailableLastMetric(metrics, names) {
  for (const name of names) {
    const value = lastMetric(metrics, name);
    if (value != null) return value;
  }
  return null;
}

function getMetric(metrics, name) {
  return metrics.find((metric) => metric?.name === name)?.data || [];
}

function valuesForMetric(metrics, name) {
  return getMetric(metrics, name)
    .map((item) => Number(item.qty))
    .filter((value) => Number.isFinite(value));
}

function sumMetric(metrics, name) {
  const values = valuesForMetric(metrics, name);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0);
}

function avgMetric(metrics, name) {
  const values = valuesForMetric(metrics, name);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function maxMetric(metrics, name) {
  const values = valuesForMetric(metrics, name);
  if (values.length === 0) return null;
  return Math.max(...values);
}

function lastMetric(metrics, name) {
  const values = valuesForMetric(metrics, name);
  return values.at(-1) ?? null;
}

function kjToKcal(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value) / 4.184;
}

function diff(value, baseline, digits = 1) {
  if (value == null || baseline == null) return null;
  return round(Number(value) - Number(baseline), digits);
}

function round(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function truncate(text, maxBytes) {
  const value = String(text || '');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n\n[TRUNCATED: input exceeded ${maxBytes} bytes]`;
}

function containsRingConnData(text) {
  if (!text) return false;
  try {
    return JSON.stringify(JSON.parse(text)).toLowerCase().includes('ringconn');
  } catch {
    return String(text).toLowerCase().includes('ringconn');
  }
}

export function buildPrompt(input) {
  const sleepDate = input.sleepDate || addDaysToIsoDate(input.targetDate, 1);
  const bodyCompositionDate = input.bodyCompositionDate || sleepDate;
  const healthData = input.healthData
    ? fenced('health-auto-export', input.healthData)
    : 'Health Auto Export data file was not found.';
  const sleepData = input.sleepData
    ? [
      `Sleep source file date: ${sleepDate}`,
      'Use this sleep_analysis as the sleep for the night immediately before the report morning.',
      input.sleepSummary ? `Readable sleep summary: ${JSON.stringify(input.sleepSummary, null, 2)}` : '',
      fenced('sleep-analysis-wake-date', input.sleepData),
    ].join('\n')
    : 'Next wake-date sleep_analysis file was not found.';
  const history = input.history?.length > 0
    ? fenced('history-summary', JSON.stringify(input.history, null, 2))
    : 'No history summary was available.';
  const trendSummary = input.trendSummary
    ? fenced('trend-summary', JSON.stringify(input.trendSummary, null, 2))
    : 'No trend summary was available.';
  const healthPlanet = input.healthPlanet
    ? fenced('healthplanet', JSON.stringify(input.healthPlanet.normalized, null, 2))
    : 'No HealthPlanet JSON was available.';
  const healthPlanetTokenStatus = input.healthPlanetTokenStatus
    ? fenced('healthplanet-token-status', JSON.stringify(input.healthPlanetTokenStatus, null, 2))
    : 'No HealthPlanet token status was available.';
  const manual = input.manualNotes.length > 0
    ? input.manualNotes.map((item) => `File: ${item.path}\n${fenced('manual-note', item.text)}`).join('\n\n')
    : 'No manual note file was found. Do not mention manual notes in the report.';
  const slackMemos = input.slackMemos?.available
    ? fenced('slack-memos', JSON.stringify(input.slackMemos.messages, null, 2))
    : 'No Slack memo was found. Do not include a memo section.';
  const ringConn = input.ringConn.snippets.length > 0
    ? input.ringConn.snippets.map((item) => `File: ${item.path}\n${fenced('ringconn', item.text)}`).join('\n\n')
    : 'No RingConn note candidate was found. Do not mention RingConn in the report.';

  return [
    'You write a concise daily health report in Japanese for Slack.',
    'The purpose is weight reduction and building a healthy body, which supports better work performance and sales results.',
    'Output only the final Japanese report. Do not explain your process.',
    '',
    'Layout rules:',
    '- Put today/target-day data first. Do not start with weekly averages.',
    '- Use clear line breaks and sections with one relevant emoji in each heading.',
    '- Use Japanese middle-dot bullets. Every bullet line must start with: \u30fb',
    '- Bullet lines should be numeric and scannable, not long paragraphs.',
    '- The report must not be only arithmetic. It must explain what should change next for fat loss and a healthier body.',
    '- Use exactly 3 action items, numbered 1 to 3.',
    '- Put the HealthPlanet API renewal line as the final line of the whole report.',
    '',
    'Display rules:',
    '- Do not write labels such as 健康プラス, 健康マイナス, health-positive, or health-negative.',
    '- Do not mention muscle mass or lean body mass at all, even if unavailable.',
    '- Do not include a dedicated previous-day-change section.',
    '- Do not show previous-day change for weight.',
    '- Do not show manual notes, RingConn notes, or Slack memo absence.',
    '- Include a memo section only if Slack memos exist.',
    '- Do not include a 読み取り section or 分析 section as a visible section.',
    '- Do not use the word 仮説 as a heading or repeated label.',
    '',
    'Analysis rules:',
    '- Do not diagnose illness or give treatment instructions.',
    '- Do not include a medical disclaimer sentence.',
    '- Never output or infer secrets such as Slack webhook URLs, API keys, tokens, access_token, or client_secret.',
    '- Do not paste raw data back. Summarize with numeric evidence.',
    '- Choose exactly one daily status in Japanese: attack day, recovery/setup day, or rest day.',
    '- Main visible metrics are sleep duration, exercise/activity volume, weight, BMI, and body fat percentage.',
    '- Prefer HealthPlanet data over Health Auto Export for body composition when available.',
    '- For exercise/activity volume, show steps and active kcal together.',
    '- Show current value and 7-day average comparison for sleep, activity, weight, and body fat percentage.',
    '- Use previous-day sleep and activity internally for advice only. Example: if yesterday was low, encourage increasing today; if yesterday was high, encourage sustainable pace.',
    '- Do not individually display heart rate, blood oxygen, or other secondary metrics unless there is a meaningful concern.',
    '- Still use heart rate, blood oxygen, body fat, memo, and other data internally for action advice.',
    '- Avoid vague words by themselves. Include exact numbers whenever possible.',
    '- Translate the numbers into concrete health improvement decisions.',
    '- If a comparison period has fewer than 4 days with data, label it as low confidence and do not overstate it.',
    '- Use kcal as the main unit for active energy. Do not use kJ as the main expression.',
    '- For sleep, use Sleep context, not sleep_analysis inside the target-date health file.',
    `- Combine target-date ${input.targetDate} activity data with sleep that ended on the morning of ${sleepDate}.`,
    `- Use HealthPlanet body composition from the report morning, ${bodyCompositionDate}, for weight, BMI, and body fat percentage.`,
    '- Write sleep duration as Japanese hours/minutes, e.g. 6 hours 10 minutes in Japanese. Do not write only decimal hours.',
    '- For weight, assume height is 162cm and set the goal at 79.0kg by June 30.',
    '- Weight-loss pace: target 1kg per 2 weeks; use 5% body weight per 30 days only as an upper-limit guide. Do not suggest extreme dieting.',
    '- Include exactly one short final line for HealthPlanet API renewal days. Example: HealthPlanet API更新まで: あと29日.',
    '',
    'Required output structure in Japanese:',
    '1. Title: Daily Health Report with target date and daily status.',
    '2. Today section: sleep, activity, weight, BMI, body fat percentage. No muscle/lean-mass line.',
    '3. 7-day trend section: short context for sleep, activity, weight, body fat percentage.',
    '4. If Slack memos exist, memo section. If none, omit the section entirely.',
    '5. Weight goal section: goal 79.0kg, current gap, sustainable pace.',
    '6. Work-performance actions section: exactly 3 concrete actions.',
    '7. Final line only: HealthPlanet API更新まで: あとN日.',
    '',
    `Target date: ${input.targetDate}`,
    `Body composition date: ${bodyCompositionDate}`,
    '',
    'Health Auto Export:',
    healthData,
    '',
    'Sleep context:',
    sleepData,
    '',
    'Trend summary:',
    trendSummary,
    '',
    'HealthPlanet body composition from report morning:',
    healthPlanet,
    '',
    'HealthPlanet token status:',
    healthPlanetTokenStatus,
    '',
    'Past daily rows:',
    history,
    '',
    'Manual notes:',
    manual,
    '',
    'Slack memos:',
    slackMemos,
    '',
    'RingConn notes/export candidates:',
    ringConn,
  ].join('\n');
}

function fenced(label, text) {
  return `\`\`\`${label}\n${text}\n\`\`\``;
}

export async function hasPostedForDate(statePath, targetDate) {
  const state = await readJson(statePath, { postedDates: {} });
  return Boolean(state.postedDates?.[targetDate]);
}

export async function markPostedForDate(statePath, targetDate, details = {}) {
  const state = await readJson(statePath, { postedDates: {} });
  state.postedDates ||= {};
  state.postedDates[targetDate] = {
    at: new Date().toISOString(),
    ...details,
  };
  await writeJson(statePath, state);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeArtifacts({ settings, targetDate, input, prompt, report }) {
  const dayDir = join(settings.outputDir, targetDate);
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, 'prompt.md'), prompt, 'utf8');
  await writeFile(join(dayDir, 'report.md'), report, 'utf8');
  await writeFile(join(dayDir, 'input-summary.json'), `${JSON.stringify(summarizeInput(input), null, 2)}\n`, 'utf8');
  return dayDir;
}

function summarizeInput(input) {
  return {
    targetDate: input.targetDate,
    bodyCompositionDate: input.bodyCompositionDate,
    healthFile: input.healthFile ? {
      path: input.healthFile.path,
      size: input.healthFile.size,
      mtimeMs: input.healthFile.mtimeMs,
    } : null,
    sleepFile: input.sleepFile ? {
      path: input.sleepFile.path,
      size: input.sleepFile.size,
      mtimeMs: input.sleepFile.mtimeMs,
    } : null,
    sleepSummary: input.sleepSummary,
    readiness: input.readiness,
    history: input.history,
    trendSummary: input.trendSummary,
    healthPlanet: input.healthPlanet ? {
      path: input.healthPlanet.path,
      normalized: input.healthPlanet.normalized,
    } : null,
    healthPlanetTokenStatus: input.healthPlanetTokenStatus,
    manualNotes: input.manualNotes.map((item) => item.path),
    slackMemos: input.slackMemos,
    ringConn: {
      available: input.ringConn.available,
      files: input.ringConn.snippets.map((item) => item.path),
      note: input.ringConn.note,
    },
  };
}

export function runCodex({ prompt, settings }) {
  return new Promise((resolve, reject) => {
    const child = spawn(settings.codexCommand, settings.codexArgs, {
      cwd: settings.codexWorkdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Codex job timed out after ${settings.jobTimeoutMs}ms`));
    }, settings.jobTimeoutMs);

    function appendStdout(chunk) {
      output += chunk.toString('utf8');
      const limit = Math.max(settings.maxOutputChars * 6, 30000);
      if (output.length > limit) output = output.slice(-limit);
    }

    function appendStderr(chunk) {
      errorOutput += chunk.toString('utf8');
      const limit = Math.max(settings.maxOutputChars * 6, 30000);
      if (errorOutput.length > limit) errorOutput = errorOutput.slice(-limit);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on('data', appendStdout);
    child.stderr.on('data', appendStderr);
    child.on('error', finish);
    child.on('close', (code) => {
      const text = code === 0 ? output : `${output}\n${errorOutput}`;
      finish(null, { code, output: extractCodexAnswer(text) });
    });
    child.stdin.end(prompt);
  });
}

export function extractCodexAnswer(output) {
  const text = String(output || '').trim();
  const marker = /\ncodex\r?\n/g;
  let match;
  let lastIndex = -1;
  while ((match = marker.exec(`\n${text}`)) !== null) {
    lastIndex = match.index + match[0].length - 1;
  }

  if (lastIndex >= 0) {
    const after = text.slice(lastIndex).trim();
    const answer = after.split(/\r?\ntokens used\r?\n/)[0]?.trim();
    if (answer) return answer;
  }

  return text;
}

export async function postToSlack({ settings, text }) {
  const webhookUrl = (await readFile(settings.slackWebhookFile, 'utf8')).trim();
  if (!webhookUrl) throw new Error(`Slack webhook file is empty: ${settings.slackWebhookFile}`);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed with ${response.status}: ${body}`);
  }
}

export async function runDailyHealthReport(options = {}) {
  const settings = options.settings || await readSettings(options.settingsPath);
  const targetDate = options.targetDate || isoDateInTimeZone(new Date(), settings.timeZone);

  if (!options.allowDuplicate && await hasPostedForDate(settings.statePath, targetDate)) {
    return { skipped: true, reason: `Report for ${targetDate} was already posted.` };
  }

  await tryFetchHealthPlanet({ settings, targetDate: addDaysToIsoDate(targetDate, 1) });
  const input = await collectInput({ targetDate, settings });
  if (!options.dryRun && !options.skipReadinessCheck && !input.readiness.ready) {
    const readinessLogPath = await writeReadinessSkip({ settings, targetDate, input });
    await tryBuildDashboard();
    return {
      skipped: true,
      reason: `Data is not ready for ${targetDate}: ${input.readiness.missing.join(', ')}`,
      targetDate,
      readiness: input.readiness,
      readinessLogPath,
    };
  }
  if (!options.dryRun && !input.healthFile) {
    throw new Error(`Health Auto Export data file was not found for ${targetDate}.`);
  }

  const prompt = buildPrompt(input);
  const narrative = options.noCodex
    ? dryRunReport(input)
    : await generateReportWithCodex({ prompt, settings });
  const report = buildVisualHealthReport(input, narrative, { settings });
  const artifactDir = await writeArtifacts({ settings, targetDate, input, prompt, report });
  if (!options.dryRun) await tryPublishDashboard();

  if (!options.dryRun) {
    await postToSlack({ settings, text: report });
    await markPostedForDate(settings.statePath, targetDate, { artifactDir });
  }

  return { skipped: false, targetDate, artifactDir, report };
}

async function writeReadinessSkip({ settings, targetDate, input }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(settings.outputDir || 'data/reports', targetDate, `readiness-skip-${timestamp}.json`);
  await writeJson(path, {
    targetDate,
    sleepDate: input.sleepDate,
    bodyCompositionDate: input.bodyCompositionDate,
    readiness: input.readiness,
    healthFile: input.healthFile?.path || null,
    sleepFile: input.sleepFile?.path || null,
    sleepSummary: input.sleepSummary,
    healthPlanet: input.healthPlanet ? {
      path: input.healthPlanet.path,
      normalized: input.healthPlanet.normalized,
    } : null,
    checkedAt: new Date().toISOString(),
  });
  return path;
}

async function tryFetchHealthPlanet({ settings, targetDate }) {
  if (!settings.healthPlanet?.enabled) return null;
  try {
    return await fetchAndSaveHealthPlanetDay({ settings, targetDate });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.warn(`HealthPlanet fetch skipped: ${error.message}`);
    return null;
  }
}

async function tryBuildDashboard() {
  try {
    await runProcess(process.execPath, ['scripts/build-dashboard.js'], { cwd: process.cwd(), timeoutMs: 120000 });
  } catch (error) {
    console.warn(`Dashboard build skipped: ${error.message}`);
  }
}

async function tryPublishDashboard() {
  try {
    await runProcess(process.execPath, ['scripts/publish-dashboard.js'], { cwd: process.cwd(), timeoutMs: 120000 });
  } catch (error) {
    console.warn(`Dashboard publish skipped: ${error.message}`);
    await tryBuildDashboard();
  }
}

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function generateReportWithCodex({ prompt, settings }) {
  const result = await runCodex({ prompt, settings });
  if (result.code !== 0) {
    throw new Error(`Codex exited with code ${result.code}: ${result.output}`);
  }
  return result.output.trim();
}

export function buildVisualHealthReport(input, narrative = '', options = {}) {
  const trend = input.trendSummary || {};
  const target = trend.target || {};
  const avg7 = trend.currentSevenDayAverage || {};
  const diff7 = trend.differenceFromCurrentSevenDayAverage || {};
  const goals = trend.goals || {};
  const rows7 = (input.history || []).filter((row) => row.metrics || row.sleep).slice(-7);
  const tokenStatus = input.healthPlanetTokenStatus;
  const status = dailyStatus({ target, goals });
  const actionItems = buildActionItems({ target, goals });
  const memoLines = formatSlackMemos(input.slackMemos);
  const dashboardUrl = dashboardUrlFromSettings(options.settings);
  const scores = buildPentagonScores({ target });

  return [
    `*Diet Coach Report ${input.targetDate}*`,
    `優先テーマ: *${status.label}*`,
    '',
    status.summary,
    '',
    '*今日の主要データ*',
    metricLine({
      label: '睡眠',
      value: target.sleepHours,
      average: avg7.sleepHours,
      diff: diff7.sleepHours,
      unit: 'hours',
      target: 6.5,
      better: 'higher',
    }),
    metricLine({
      label: '歩数',
      value: target.steps,
      average: avg7.steps,
      diff: diff7.steps,
      unit: 'steps',
      target: 8000,
      better: 'higher',
    }),
    metricLine({
      label: '活動量',
      value: target.activeEnergyKcal,
      average: avg7.activeEnergyKcal,
      diff: diff7.activeEnergyKcal,
      unit: 'kcal',
      target: 650,
      better: 'higher',
    }),
    bodyLine({ target, avg7, diff7, goals }),
    bodyFatLine({ target, avg7, diff7 }),
    '',
    '*5角形パラメータ*',
    ...scores.map((score) => pentagonScoreLine(score)),
    '',
    '*今日やること*',
    ...actionItems.map((item, index) => `${index + 1}. ${item}`),
    '',
    '*今週の筋トレ方針*',
    ...buildTrainingItems({ target }),
    '',
    '*直近7日の流れ*',
    trendLine('睡眠', rows7, (row) => row.sleep?.totalSleepHours, 'hours'),
    trendLine('歩数', rows7, (row) => row.metrics?.steps, 'steps'),
    trendLine('体重', rows7, (row) => row.metrics?.weightKg, 'kg'),
    trendLine('体脂肪率', rows7, (row) => row.metrics?.bodyFatPercent, 'percent'),
    ...(memoLines.length > 0 ? ['', '*Slackメモ*', ...memoLines] : []),
    '',
    `詳細ダッシュボード: ${dashboardUrl}`,
    tokenStatus?.remainingDays != null ? `HealthPlanet API更新まで: あと${tokenStatus.remainingDays}日` : null,
  ].filter((line) => line != null).join('\n');
}

function dailyStatus({ target, goals }) {
  const sleep = target.sleepHours == null ? null : Number(target.sleepHours);
  const steps = target.steps == null ? null : Number(target.steps);
  const weight = Number(goals.latestWeightKg ?? target.weightKg);
  if (!Number.isFinite(sleep) || !Number.isFinite(steps)) {
    return {
      label: '未取得データを確認',
      summary: '睡眠または歩数が未取得です。回復状態が読めないので、今日は筋トレを20分以内にして、食事と歩数の最低ラインを守ります。',
    };
  }
  if (sleep < 5.5) {
    return {
      label: '回復を守りながら減量',
      summary: `睡眠が${formatMetricValue(sleep, 'hours')}で短めです。今日は高強度ではなく、歩数・食事・軽い筋トレで崩さない日です。`,
    };
  }
  if (steps < 8000) {
    return {
      label: '活動量を戻す',
      summary: `歩数が${formatMetricValue(steps, 'steps')}です。今日の主目的は8,000歩に近づけて、消費量の土台を戻すことです。`,
    };
  }
  if (Number.isFinite(weight) && weight > 79) {
    return {
      label: '筋トレで体を締める',
      summary: `79.0kgまであと${formatMetricValue(weight - 79, 'kg')}。体重を落としながら筋肉を残すため、今日は筋トレとたんぱく質を優先します。`,
    };
  }
  return {
    label: '維持と習慣化',
    summary: '体重目標は射程圏内です。リバウンドを避けるため、食事を崩さず筋トレと睡眠を継続します。',
  };
}

function metricLine({ label, value, average, diff, unit, target, better }) {
  if (value == null) return `・${label}: データなし`;
  const ratio = target ? Number(value) / target : null;
  const mark = healthMark(diff, better);
  return `・${label}: ${formatMetricValue(value, unit)} ${progressBar(ratio)} / 7日平均 ${formatMetricValue(average, unit)} / 平均差 ${signedMetric(diff, unit)} ${mark}`;
}

function bodyLine({ target, avg7, diff7, goals }) {
  const weight = target.weightKg;
  if (weight == null) return '・体重: データなし';
  const gap = goals.kgToTarget ?? diff(weight, goals.weightTargetKgByJuneEnd ?? 79, 1);
  return `・体重: ${formatMetricValue(weight, 'kg')} / 7日平均 ${formatMetricValue(avg7.weightKg, 'kg')} / 平均差 ${signedMetric(diff7.weightKg, 'kg')} / 79.0kgまであと ${formatMetricValue(gap, 'kg')}`;
}

function bodyFatLine({ target, avg7, diff7 }) {
  if (target.bodyFatPercent == null) return '・体脂肪率: データなし';
  const mark = healthMark(diff7.bodyFatPercent, 'lower');
  return `・体脂肪率: ${formatMetricValue(target.bodyFatPercent, 'percent')} / 7日平均 ${formatMetricValue(avg7.bodyFatPercent, 'percent')} / 平均差 ${signedMetric(diff7.bodyFatPercent, 'point')} ${mark}`;
}

function trendLine(label, rows, picker, unit) {
  const values = rows.map(picker);
  const displayValues = values.filter((value) => value != null && Number.isFinite(Number(value)));
  if (displayValues.length === 0) return `・${label}: データなし`;
  const last = displayValues.at(-1);
  return `・${label}: ${sparkline(values)}  最新 ${formatMetricValue(last, unit)}`;
}

function buildActionItems({ target, goals }) {
  const items = [];
  if (target.sleepHours == null) {
    items.push('睡眠データが未取得。回復状態が読めないので、筋トレは20分以内でフォーム確認にする。');
  } else if (target.sleepHours < 5.5) {
    items.push('睡眠が短い。今日は高強度を避け、スクワット・壁腕立て・プランクを各2セットまで。');
  } else {
    items.push('筋トレを20分実行。下半身・背中・体幹のどれかを選び、最後までやり切る。');
  }
  if (target.steps == null) {
    items.push('歩数データが未取得。最低ラインは8,000歩。昼食後10分、夕方10分で分割して歩く。');
  } else if (target.steps < 8000) {
    items.push(`歩数を8,000歩へ寄せる。現在 ${formatMetricValue(target.steps, 'steps')} なので、昼と夕方に各10分歩く。`);
  } else {
    items.push('歩数は基準クリア。追加で追い込みすぎず、筋トレと食事の質を優先する。');
  }
  const gap = goals.kgToTarget;
  if (gap != null && gap > 0) {
    items.push(`79.0kgまであと${formatMetricValue(gap, 'kg')}。夜の間食を削り、毎食たんぱく質を先に食べる。`);
  } else {
    items.push('体重目標は達成圏。食事を崩さず、筋トレと睡眠でリバウンドを防ぐ。');
  }
  return items;
}

function buildTrainingItems({ target }) {
  const tired = target.sleepHours == null || target.sleepHours < 5.5;
  if (tired) {
    return [
      '・回復日メニュー: スクワット10回 x 2、壁腕立て10回 x 2、プランク20秒 x 2',
      '・目的: 疲労を残さず、筋トレ習慣だけは切らさない',
    ];
  }
  return [
    '・下半身: スクワット10回 x 3、ヒップヒンジ12回 x 3',
    '・上半身: 腕立て8回 x 3、ローイング12回 x 3',
    '・体幹: プランク30秒 x 3、デッドバグ左右10回 x 2',
  ];
}

function buildPentagonScores({ target }) {
  return [
    { label: '減量', score: clamp(100 - Math.max(0, (Number(target.weightKg ?? 84) - 79) * 12), 0, 100) },
    { label: '活動', score: clamp((Number(target.steps ?? 0) / 8000) * 100, 0, 100) },
    { label: '睡眠', score: clamp((Number(target.sleepHours ?? 0) / 6.5) * 100, 0, 100) },
    { label: '体脂肪', score: clamp(100 - Math.max(0, (Number(target.bodyFatPercent ?? 32) - 25) * 9), 0, 100) },
    { label: '筋トレ', score: estimateStrengthScore(target) },
  ].map((item) => ({ ...item, score: Math.round(item.score) }));
}

function estimateStrengthScore(target) {
  let score = 45;
  if (Number(target.steps ?? 0) >= 8000) score += 18;
  if (Number(target.sleepHours ?? 0) >= 6) score += 18;
  if (Number(target.activeEnergyKcal ?? 0) >= 650) score += 12;
  if (Number(target.bodyFatPercent ?? 99) <= 28) score += 7;
  return clamp(score, 0, 100);
}

function pentagonScoreLine({ label, score }) {
  return `・${label}: ${score}/100 ${progressBar(score / 100)}`;
}

function formatSlackMemos(slackMemos) {
  if (!slackMemos?.available || !Array.isArray(slackMemos.messages)) return [];
  return slackMemos.messages
    .map((message) => cleanSlackText(message.text || message.transcript || '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((text) => `・${truncateText(text, 90)}`);
}

function formatMetricValue(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return 'なし';
  const number = Number(value);
  if (unit === 'hours') return formatHours(number);
  if (unit === 'steps') return `${Math.round(number).toLocaleString('ja-JP')}歩`;
  if (unit === 'kcal') return `${Math.round(number).toLocaleString('ja-JP')}kcal`;
  if (unit === 'kg') return `${round(number, 1).toFixed(1)}kg`;
  if (unit === 'percent') return `${round(number, 1).toFixed(1)}%`;
  if (unit === 'point') return `${round(number, 1).toFixed(1)}pt`;
  return String(round(number, 1));
}

function signedMetric(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return '比較不可';
  const number = Number(value);
  const prefix = number > 0 ? '+' : '';
  if (unit === 'hours') return `${number > 0 ? '+' : number < 0 ? '-' : ''}${formatHours(Math.abs(number))}`;
  if (unit === 'steps') return `${prefix}${Math.round(number).toLocaleString('ja-JP')}歩`;
  if (unit === 'kcal') return `${prefix}${Math.round(number).toLocaleString('ja-JP')}kcal`;
  if (unit === 'kg') return `${prefix}${round(number, 1).toFixed(1)}kg`;
  if (unit === 'point') return `${prefix}${round(number, 1).toFixed(1)}pt`;
  return `${prefix}${round(number, 1)}`;
}

function healthMark(delta, better) {
  if (delta == null || !Number.isFinite(Number(delta)) || Number(delta) === 0) return '→';
  const positive = better === 'higher' ? Number(delta) > 0 : Number(delta) < 0;
  return positive ? '改善' : '要調整';
}

function progressBar(ratio) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return '';
  const width = 8;
  const filled = Math.max(0, Math.min(width, Math.round(Number(ratio) * width)));
  return `[${'■'.repeat(filled)}${'□'.repeat(width - filled)}]`;
}

function sparkline(values) {
  const ticks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const numbers = values.map((value) => value == null ? null : Number(value));
  const finite = numbers.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return '-------';
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return numbers.map((value) => {
    if (!Number.isFinite(value)) return '·';
    if (max === min) return '▄';
    const index = Math.round(((value - min) / (max - min)) * (ticks.length - 1));
    return ticks[index];
  }).join('');
}

function dashboardUrlFromSettings(settings) {
  return settings?.dashboardUrl || 'https://lmj-ai-agent.github.io/healthcare-agent-dashboard/';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function truncateText(text, maxLength) {
  const value = String(text || '');
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
function dryRunReport(input) {
  const healthName = input.healthFile ? basename(input.healthFile.path) : 'not found';
  return [
    `*Daily Health Report - ${input.targetDate}*`,
    '判定: dry-run',
    '',
    `Health Auto Export: ${healthName}`,
    `Manual notes: ${input.manualNotes.length} file(s)`,
    `Slack memos: ${input.slackMemos?.messages?.length || 0} message(s)`,
    `RingConn: ${input.ringConn.note}`,
  ].join('\n');
}

function parseArgs(argv) {
  const options = { settingsPath: 'config/settings.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-codex') options.noCodex = true;
    else if (arg === '--allow-duplicate') options.allowDuplicate = true;
    else if (arg === '--skip-readiness-check') options.skipReadinessCheck = true;
    else if (arg === '--yesterday') options.yesterday = true;
    else if (arg === '--date') options.targetDate = argv[++index];
    else if (arg.startsWith('--date=')) options.targetDate = arg.slice('--date='.length);
    else if (arg === '--settings') options.settingsPath = argv[++index];
    else if (arg.startsWith('--settings=')) options.settingsPath = arg.slice('--settings='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const settings = await readSettings(options.settingsPath);
  if (options.yesterday && !options.targetDate) {
    options.targetDate = yesterdayIsoDateInTimeZone(new Date(), settings.timeZone);
  }
  const result = await runDailyHealthReport({ ...options, settings });
  if (result.skipped) {
    console.log(result.reason);
  } else {
    console.log(`Daily health report generated for ${result.targetDate}`);
    console.log(`Artifacts: ${result.artifactDir}`);
    if (options.dryRun) {
      console.log('\n--- Report preview ---');
      console.log(result.report);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

