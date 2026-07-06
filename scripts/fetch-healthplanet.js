#!/usr/bin/env node
import { addDaysToIsoDate, isoDateInTimeZone, readSettings } from '../src/healthReport.js';
import { fetchAndSaveHealthPlanetDay } from '../src/healthPlanet.js';

const settings = await readSettings(readArg('--settings') || 'config/settings.json');
const targetDate = readArg('--date') || (hasFlag('--yesterday')
  ? addDaysToIsoDate(isoDateInTimeZone(new Date(), settings.timeZone || 'Asia/Tokyo'), -1)
  : isoDateInTimeZone(new Date(), settings.timeZone || 'Asia/Tokyo'));

const result = await fetchAndSaveHealthPlanetDay({ settings, targetDate });
if (!result) {
  console.log('HealthPlanet integration is disabled.');
} else {
  console.log(`HealthPlanet JSON saved for ${targetDate}: ${result.path}`);
  console.log(JSON.stringify(result.normalized, null, 2));
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || null;
}
