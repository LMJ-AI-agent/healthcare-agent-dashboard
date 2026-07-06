import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HEALTHPLANET_AUTH_URL = 'https://www.healthplanet.jp/oauth/auth';
const HEALTHPLANET_TOKEN_URL = 'https://www.healthplanet.jp/oauth/token';
const HEALTHPLANET_INNERSCAN_URL = 'https://www.healthplanet.jp/status/innerscan.json';

export const HEALTHPLANET_TAGS = {
  weightKg: '6021',
  bodyFatPercent: '6022',
  muscleMassKg: '6023',
  muscleScore: '6024',
  visceralFatLevelDecimal: '6025',
  visceralFatLevel: '6026',
  basalMetabolismKcal: '6027',
  metabolicAge: '6028',
  boneMassKg: '6029',
};

const TAG_TO_FIELD = Object.fromEntries(
  Object.entries(HEALTHPLANET_TAGS).map(([field, tag]) => [tag, field]),
);

export async function readHealthPlanetClient(path) {
  const text = await readFile(path, 'utf8');
  const client = JSON.parse(text);
  for (const key of ['client_id', 'client_secret', 'redirect_uri']) {
    if (!client[key]) throw new Error(`HealthPlanet client config is missing ${key}.`);
  }
  return client;
}

export function buildHealthPlanetAuthUrl(client, scope = 'innerscan') {
  const url = new URL(HEALTHPLANET_AUTH_URL);
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', client.redirect_uri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

export async function exchangeHealthPlanetCode({ client, code, tokenPath }) {
  const params = new URLSearchParams();
  params.set('client_id', client.client_id);
  params.set('client_secret', client.client_secret);
  params.set('redirect_uri', client.redirect_uri);
  params.set('code', code);
  params.set('grant_type', 'authorization_code');

  const response = await fetch(HEALTHPLANET_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const token = await response.json();
  if (!response.ok || token.error) {
    throw new Error(`HealthPlanet token exchange failed: ${JSON.stringify(token)}`);
  }
  token.obtained_at = new Date().toISOString();
  await writeJson(tokenPath, token);
  return token;
}

export async function readHealthPlanetToken(path) {
  const token = JSON.parse(await readFile(path, 'utf8'));
  if (!token.access_token) throw new Error('HealthPlanet token file is missing access_token.');
  return token;
}

export async function readHealthPlanetTokenStatus(settings, now = new Date()) {
  if (!settings.healthPlanet?.enabled) return null;
  const tokenPath = settings.healthPlanet.tokenFile || 'secrets/healthplanet-token.json';
  try {
    const token = JSON.parse(await readFile(tokenPath, 'utf8'));
    const obtainedAt = token.obtained_at ? new Date(token.obtained_at) : null;
    const expiresInSeconds = Number(token.expires_in);
    if (!obtainedAt || !Number.isFinite(expiresInSeconds)) {
      return { available: false, reason: 'HealthPlanet token expiry is unknown.' };
    }
    const expiresAt = new Date(obtainedAt.getTime() + expiresInSeconds * 1000);
    const remainingMs = expiresAt.getTime() - now.getTime();
    return {
      available: true,
      obtainedAt: obtainedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      remainingDays: Math.max(0, Math.ceil(remainingMs / 86_400_000)),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, reason: 'HealthPlanet token file was not found.' };
    throw error;
  }
}

export async function fetchHealthPlanetInnerscan({ accessToken, from, to, tags = Object.values(HEALTHPLANET_TAGS) }) {
  const url = new URL(HEALTHPLANET_INNERSCAN_URL);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('tag', tags.join(','));
  url.searchParams.set('date', '1');
  url.searchParams.set('from', toHealthPlanetTimestamp(from, '000000'));
  url.searchParams.set('to', toHealthPlanetTimestamp(to, '235959'));

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`HealthPlanet innerscan fetch failed: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function fetchAndSaveHealthPlanetDay({ settings, targetDate }) {
  if (!settings.healthPlanet?.enabled) return null;
  const clientPath = settings.healthPlanet.clientFile || 'secrets/healthplanet-client.json';
  const tokenPath = settings.healthPlanet.tokenFile || 'secrets/healthplanet-token.json';
  const outputDir = settings.healthPlanet.outputDir || 'data/healthplanet';
  const client = await readHealthPlanetClient(clientPath);
  const token = await readHealthPlanetToken(tokenPath);
  const data = await fetchHealthPlanetInnerscan({
    accessToken: token.access_token,
    from: targetDate,
    to: targetDate,
    tags: settings.healthPlanet.tags || Object.values(HEALTHPLANET_TAGS),
  });
  const normalized = normalizeHealthPlanetInnerscan(data, targetDate);
  const path = join(outputDir, `${targetDate}.json`);
  await writeJson(path, {
    source: 'healthplanet',
    fetchedAt: new Date().toISOString(),
    targetDate,
    clientId: client.client_id,
    raw: data,
    normalized,
  });
  return { path, data, normalized };
}

export async function readHealthPlanetDay(settings, targetDate) {
  const outputDir = settings.healthPlanet?.outputDir || 'data/healthplanet';
  const path = join(outputDir, `${targetDate}.json`);
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return { path, data, normalized: data.normalized || normalizeHealthPlanetInnerscan(data.raw || data, targetDate) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function normalizeHealthPlanetInnerscan(data, targetDate = null) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  const values = {};
  for (const row of rows) {
    const tag = String(row.tag || '');
    const field = TAG_TO_FIELD[tag];
    if (!field) continue;
    if (targetDate && healthPlanetDateToIso(row.date) !== targetDate) continue;
    values[field] = {
      value: Number(row.keydata),
      tag,
      measuredAt: row.date,
      model: row.model || null,
    };
  }

  const weightKg = valueOf(values.weightKg);
  const heightCm = Number(data?.height) || null;
  return {
    measuredDate: targetDate,
    heightCm,
    sex: data?.sex || null,
    weightKg,
    bodyFatPercent: valueOf(values.bodyFatPercent),
    bodyMassIndex: weightKg && heightCm ? round(weightKg / ((heightCm / 100) ** 2), 1) : null,
    muscleMassKg: valueOf(values.muscleMassKg),
    muscleScore: valueOf(values.muscleScore),
    visceralFatLevel: valueOf(values.visceralFatLevelDecimal) ?? valueOf(values.visceralFatLevel),
    basalMetabolismKcal: valueOf(values.basalMetabolismKcal),
    metabolicAge: valueOf(values.metabolicAge),
    boneMassKg: valueOf(values.boneMassKg),
    values,
  };
}

export function mergeHealthPlanetMetrics(metrics, normalized) {
  if (!normalized) return metrics;
  return {
    ...metrics,
    weightKg: normalized.weightKg ?? metrics?.weightKg ?? null,
    bodyMassIndex: normalized.bodyMassIndex ?? metrics?.bodyMassIndex ?? null,
    bodyFatPercent: normalized.bodyFatPercent ?? metrics?.bodyFatPercent ?? null,
    muscleMassKg: normalized.muscleMassKg ?? metrics?.muscleMassKg ?? null,
    muscleScore: normalized.muscleScore ?? metrics?.muscleScore ?? null,
    visceralFatLevel: normalized.visceralFatLevel ?? metrics?.visceralFatLevel ?? null,
    basalMetabolismKcal: normalized.basalMetabolismKcal ?? metrics?.basalMetabolismKcal ?? null,
    metabolicAge: normalized.metabolicAge ?? metrics?.metabolicAge ?? null,
    boneMassKg: normalized.boneMassKg ?? metrics?.boneMassKg ?? null,
  };
}

function valueOf(item) {
  return Number.isFinite(item?.value) ? item.value : null;
}

function toHealthPlanetTimestamp(isoDate, suffix) {
  return `${isoDate.replaceAll('-', '')}${suffix}`;
}

function healthPlanetDateToIso(value) {
  const text = String(value || '');
  if (text.length < 8) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function round(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
