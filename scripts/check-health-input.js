import { collectInput, readSettings, yesterdayIsoDateInTimeZone } from '../src/healthReport.js';

const settings = await readSettings('config/settings.json');
const targetDate = process.argv[2] || yesterdayIsoDateInTimeZone(new Date(), settings.timeZone);
const input = await collectInput({ targetDate, settings });

console.log(JSON.stringify({
  targetDate: input.targetDate,
  sleepDate: input.sleepDate,
  sleepFile: input.sleepFile?.path || null,
  sleepSummary: input.sleepSummary,
  readiness: input.readiness,
}, null, 2));
