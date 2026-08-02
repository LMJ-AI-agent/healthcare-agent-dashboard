const FALLBACK_SERIES = [
  ['2026-06-11', 80.7], ['2026-06-16', 81.9], ['2026-06-17', 80.2],
  ['2026-06-22', 81.7], ['2026-06-23', 82.2], ['2026-06-29', 81.2],
  ['2026-07-03', 80.7], ['2026-07-12', 82.7], ['2026-07-14', 80.4],
  ['2026-07-17', 81.7], ['2026-07-19', 82.6], ['2026-07-22', 81.7],
].map(([date, value]) => ({ date, value }));

const FALLBACK_RECORDS = [
  { date: '2026-07-22', metrics: { steps: null, activeEnergyKcal: null, weightKg: 81.7, bodyFatPercent: 27.7 } },
  { date: '2026-07-19', metrics: { steps: 6545, activeEnergyKcal: 1052, weightKg: 82.6, bodyFatPercent: 27.5 } },
  { date: '2026-07-17', metrics: { steps: 4110, activeEnergyKcal: 383, weightKg: 81.7, bodyFatPercent: 28.2 } },
  { date: '2026-07-16', metrics: { steps: 3677, activeEnergyKcal: 309, weightKg: 81.2, bodyFatPercent: 27.0 } },
  { date: '2026-07-14', metrics: { steps: null, activeEnergyKcal: null, weightKg: 80.4, bodyFatPercent: 27.8 } },
  { date: '2026-07-12', metrics: { steps: 4338, activeEnergyKcal: 183, weightKg: 82.7, bodyFatPercent: 28.4 } },
];

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let nextGoalWeight = 76;
let nextGoalDeadline = '2026-10-31';
let selectedRecordMonth = null;
const PROJECT_START_WEIGHT = 81.7;
const FORECAST_WINDOW_DAYS = 14;

function setupReveals() {
  const elements = [...document.querySelectorAll('[data-reveal]')];
  if (reduceMotion) {
    elements.forEach(element => element.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.14, rootMargin: '0px 0px -6%' });
  elements.forEach(element => observer.observe(element));
}

function setupCounters() {
  const counters = [...document.querySelectorAll('.count-up')];
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const element = entry.target;
      observer.unobserve(element);
      animateCounter(element);
    });
  }, { threshold: 0.55 });
  counters.forEach(counter => observer.observe(counter));
}

function animateCounter(element) {
  const target = Number(element.dataset.count);
  const decimals = Number(element.dataset.decimals || 0);
  const suffix = element.dataset.suffix || '';
  element.dataset.animated = 'true';
  if (reduceMotion || !Number.isFinite(target)) {
    element.textContent = formatNumber(target, decimals, suffix);
    return;
  }
  const start = performance.now();
  const duration = 1050;
  element.classList.add('is-popping');
  const tick = now => {
    const progress = Math.min((now - start) / duration, 1);
    const c1 = 1.55;
    const c3 = c1 + 1;
    const eased = 1 + c3 * Math.pow(progress - 1, 3) + c1 * Math.pow(progress - 1, 2);
    element.textContent = formatNumber(target * eased, decimals, suffix);
    if (progress < 1) requestAnimationFrame(tick);
    else {
      element.textContent = formatNumber(target, decimals, suffix);
      window.setTimeout(() => element.classList.remove('is-popping'), 420);
    }
  };
  requestAnimationFrame(tick);
}

function updateCounter(id, value, decimals, suffix) {
  const element = document.getElementById(id);
  if (!element || !Number.isFinite(Number(value))) return;
  element.dataset.count = String(value);
  element.dataset.decimals = String(decimals);
  element.dataset.suffix = suffix;
  if (element.dataset.animated === 'true' || reduceMotion) {
    element.textContent = formatNumber(value, decimals, suffix);
  }
}

function setupWeightChart(initialSeries) {
  const canvas = document.getElementById('weightTrendCanvas');
  if (!canvas) return { update() {} };
  let series = initialSeries;
  let frame = 0;
  let progress = 0;
  let finished = false;

  const draw = requestedProgress => {
    progress = requestedProgress;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const context = canvas.getContext('2d');
    if (!context || !series.length) return;
    context.scale(pixelRatio, pixelRatio);
    context.clearRect(0, 0, width, height);
    context.save();
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();

    const values = series.map(item => item.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max(0.35, (rawMax - rawMin) * 0.15);
    const yMin = Math.floor((rawMin - padding) * 10) / 10;
    const yMax = Math.ceil((rawMax + padding) * 10) / 10;
    const startTime = Date.parse(series[0].date + 'T00:00:00Z');
    const endTime = Date.parse(series[series.length - 1].date + 'T00:00:00Z');
    const timeSpan = Math.max(1, endTime - startTime);
    const points = series.map(item => ({
      x: ((Date.parse(item.date + 'T00:00:00Z') - startTime) / timeSpan) * width,
      y: Math.max(0, Math.min(height, ((yMax - item.value) / Math.max(0.1, yMax - yMin)) * height)),
    }));
    const travel = Math.min(Math.max(requestedProgress, 0), 1) * (points.length - 1);
    const whole = Math.floor(travel);
    const fraction = travel - whole;
    const visible = points.slice(0, whole + 1);
    if (whole < points.length - 1) {
      const current = points[whole];
      const next = points[whole + 1];
      visible.push({ x: current.x + (next.x - current.x) * fraction, y: current.y + (next.y - current.y) * fraction });
    }

    if (nextGoalWeight >= yMin && nextGoalWeight <= yMax) {
      const goalY = ((yMax - nextGoalWeight) / (yMax - yMin)) * height;
      context.save();
      context.setLineDash([8, 7]);
      context.strokeStyle = '#ff5d35';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(0, goalY);
      context.lineTo(width, goalY);
      context.stroke();
      context.restore();
    }

    context.beginPath();
    visible.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    const last = visible[visible.length - 1];
    context.lineTo(last.x, height);
    context.lineTo(visible[0].x, height);
    context.closePath();
    const fill = context.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, 'rgba(93, 92, 246, .30)');
    fill.addColorStop(1, 'rgba(93, 92, 246, 0)');
    context.fillStyle = fill;
    context.fill();

    context.beginPath();
    visible.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = '#5d5cf6';
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke();

    points.slice(0, Math.min(whole + 1, points.length)).forEach((point, index) => {
      context.beginPath();
      context.arc(point.x, point.y, index === points.length - 1 ? 7 : 5, 0, Math.PI * 2);
      context.fillStyle = index === points.length - 1 ? '#c8ff35' : '#fffdf8';
      context.fill();
      context.strokeStyle = index === points.length - 1 ? '#101115' : '#5d5cf6';
      context.lineWidth = 3;
      context.stroke();
    });
    context.restore();
    updateChartLabels(series, yMin, yMax);
  };

  const resizeObserver = new ResizeObserver(() => draw(finished ? 1 : progress));
  resizeObserver.observe(canvas);
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    if (reduceMotion) {
      finished = true;
      draw(1);
      return;
    }
    const start = performance.now();
    const animate = now => {
      const elapsed = Math.min((now - start) / 1200, 1);
      draw(1 - Math.pow(1 - elapsed, 3));
      if (elapsed < 1) frame = requestAnimationFrame(animate);
      else finished = true;
    };
    frame = requestAnimationFrame(animate);
  }, { threshold: 0.35 });
  observer.observe(canvas);

  return {
    update(nextSeries) {
      if (!Array.isArray(nextSeries) || nextSeries.length < 2) return;
      series = nextSeries;
      draw(finished ? 1 : progress);
    },
  };
}

function updateChartLabels(series, yMin, yMax) {
  setText('chartYTop', yMax.toFixed(1) + 'kg');
  setText('chartYBottom', yMin.toFixed(1) + 'kg');
  const middle = series[Math.floor((series.length - 1) / 2)];
  setText('chartXStart', shortDate(series[0].date));
  setText('chartXMiddle', shortDate(middle.date));
  setText('chartXEnd', shortDate(series[series.length - 1].date));
  const inRange = nextGoalWeight >= yMin && nextGoalWeight <= yMax;
  setText('chartGoalLabel', inRange ? 'NEXT GATE / 表示レンジ内' : 'NEXT GATE / 表示レンジ外');
  setText('chartGoalValue', nextGoalWeight.toFixed(1) + 'kg' + (inRange ? '' : nextGoalWeight < yMin ? ' ↓' : ' ↑'));
}

function renderRecords(records) {
  const container = document.getElementById('recordsTable');
  const tabs = document.getElementById('recordMonthTabs');
  const summary = document.getElementById('recordsMonthSummary');
  if (!container || !tabs || !summary) return;

  const availableRecords = records.filter(record => hasAnyMetric(record));
  const months = [...new Set(availableRecords.map(record => record.date.slice(0, 7)))].sort().reverse();
  if (!months.length) return;
  if (!months.includes(selectedRecordMonth)) selectedRecordMonth = months[0];

  tabs.innerHTML = months.map(month => (
    '<button type="button" class="record-month-tab" role="tab" aria-selected="' + (month === selectedRecordMonth) + '" data-month="' + month + '">' +
      monthLabel(month) +
    '</button>'
  )).join('');
  tabs.querySelectorAll('[data-month]').forEach(button => {
    button.addEventListener('click', () => {
      selectedRecordMonth = button.dataset.month;
      renderRecords(records);
    });
  });

  const monthRecords = availableRecords
    .filter(record => record.date.startsWith(selectedRecordMonth))
    .sort((a, b) => a.date.localeCompare(b.date));
  const weightByDate = new Map(availableRecords
    .filter(record => isNumber(record.metrics?.weightKg))
    .map(record => [record.date, Number(record.metrics.weightKg)]));
  const monthWeights = monthRecords.filter(record => isNumber(record.metrics?.weightKg));
  const monthStartWeight = monthWeights[0]?.metrics?.weightKg;
  const monthLatestWeight = monthWeights.at(-1)?.metrics?.weightKg;
  const monthChange = isNumber(monthStartWeight) && isNumber(monthLatestWeight)
    ? Number(monthLatestWeight) - Number(monthStartWeight)
    : null;
  const stepValues = monthRecords.map(record => record.metrics?.steps).filter(isNumber).map(Number);
  const averageSteps = stepValues.length
    ? stepValues.reduce((sum, value) => sum + value, 0) / stepValues.length
    : null;

  setText('recordsMonthLabel', monthLabel(selectedRecordMonth).toUpperCase());
  summary.innerHTML =
    '<span>MONTH START<strong>' + formatWeight(monthStartWeight) + '</strong></span>' +
    '<span>MONTH CHANGE<strong>' + formatSignedWeight(monthChange) + '</strong></span>' +
    '<span>DAILY RECORDS<strong>' + monthRecords.length + '日 / 平均' + formatInteger(averageSteps) + '歩</strong></span>';

  const header = '<div class="record-row record-header"><span>DATE</span><span>WEIGHT</span><span>前日比</span><span>月初比</span><span>STEPS</span><span>BODY FAT</span></div>';
  const rows = [...monthRecords].reverse().map(record => {
    const metrics = record.metrics || {};
    const weight = isNumber(metrics.weightKg) ? Number(metrics.weightKg) : null;
    const previousWeight = weightByDate.get(previousIsoDate(record.date));
    const previousChange = weight != null && isNumber(previousWeight) ? weight - previousWeight : null;
    const startChange = weight != null && isNumber(monthStartWeight) ? weight - Number(monthStartWeight) : null;
    return '<div class="record-row">' +
      '<span data-label="DATE"><b>' + record.date.slice(0, 5) + '</b>' + record.date.slice(5).replace('-', '.') + '</span>' +
      '<span data-label="WEIGHT">' + (weight != null ? '<strong>' + weight.toFixed(1) + '</strong> kg' : '—') + '</span>' +
      '<span data-label="前日比">' + formatDeltaMarkup(previousChange) + '</span>' +
      '<span data-label="月初比">' + formatDeltaMarkup(startChange) + '</span>' +
      '<span data-label="STEPS">' + formatInteger(metrics.steps) + '</span>' +
      '<span data-label="BODY FAT">' + (isNumber(metrics.bodyFatPercent) ? metrics.bodyFatPercent.toFixed(1) + ' %' : '—') + '</span>' +
      '</div>';
  }).join('');
  container.innerHTML = header + rows;
  container.scrollTop = 0;
}

async function refreshDashboard(chart) {
  try {
    const response = await fetch('./health-data.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('health-data.json: ' + response.status);
    const data = await response.json();
    const records = Array.isArray(data.records) ? data.records : [];
    if (!records.length) throw new Error('No health records');
    nextGoalWeight = numberOr(data.goals?.nextWeightKg, 76);
    nextGoalDeadline = data.goals?.nextDeadline || '2026-10-31';

    const weightRecord = [...records].reverse().find(record => isNumber(record.metrics?.weightKg));
    const bodyFatRecord = [...records].reverse().find(record => isNumber(record.metrics?.bodyFatPercent));
    const currentWeight = weightRecord?.metrics?.weightKg;
    const bodyFat = bodyFatRecord?.metrics?.bodyFatPercent;
    const latestDate = weightRecord?.date || records[records.length - 1].date;
    const gap = isNumber(currentWeight) ? Math.max(0, currentWeight - nextGoalWeight) : null;
    const days = daysBetween(latestDate, nextGoalDeadline);
    const weeklyPace = gap != null && days > 0 ? gap / (days / 7) : 0;
    const bodyFatAverage = numberOr(
      bodyFatRecord?.coaching?.sevenDay?.bodyFatPercent,
      numberOr(bodyFatRecord?.average7?.bodyFatPercent, averageRecent(records, 'bodyFatPercent')),
    );

    if (isNumber(currentWeight)) {
      updateCounter('currentWeightCounter', currentWeight, 1, 'kg');
      updateCounter('chartCurrentWeight', currentWeight, 1, 'kg');
      setText('heroCurrentWeight', '現在 ' + currentWeight.toFixed(1) + 'kg');
      const dailyWeight = document.getElementById('dailyWeight');
      if (dailyWeight) dailyWeight.innerHTML = currentWeight.toFixed(1) + '<span>KG</span>';
    }
    if (gap != null) {
      updateCounter('nextGapCounter', gap, 1, 'kg');
      setText('heroNextGap', 'あと ' + gap.toFixed(1) + 'kg');
      setText('nextGapLabel', nextGoalWeight.toFixed(0) + 'kgまであと' + gap.toFixed(1) + 'kg');
    }
    if (isNumber(bodyFat)) updateCounter('bodyFatCounter', bodyFat, 1, '%');
    if (isNumber(bodyFatAverage)) setText('bodyFatAverageLabel', '7日平均 ' + bodyFatAverage.toFixed(1) + '%');
    updateCounter('weeklyPaceCounter', weeklyPace, 2, 'kg');
    setText('weeklyPaceLabel', weeklyPace > 0 ? '週' + weeklyPace.toFixed(2) + 'kgを、毎日の動きへ' : '達成後は、心地よく維持');
    updateMovementEquivalents(weeklyPace, currentWeight);
    updateCounter('daysToGateCounter', Math.max(0, days), 0, '日');
    setText('nextGateWeight', nextGoalWeight.toFixed(1));
    setText('chartLastUpdate', latestDate.replaceAll('-', '.'));
    updateControlCenter(records, {
      currentWeight,
      latestDate,
      targetWeight: nextGoalWeight,
      deadline: nextGoalDeadline,
      days,
      goals: data.goals || {},
    });

    const weightSeries = records
      .filter(record => isNumber(record.metrics?.weightKg))
      .slice(-30)
      .map(record => ({ date: record.date, value: record.metrics.weightKg }));
    chart.update(weightSeries);
    renderRecords(records);
  } catch (error) {
    console.warn('最新データの読み込みに失敗したため、前回値を表示します。', error);
  }
}

function averageRecent(records, key) {
  const values = records.slice(-7).map(record => record.metrics?.[key]).filter(isNumber);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function updateControlCenter(records, options) {
  const forecast = calculateGateForecast(records, options);
  if (!forecast) return;

  updateCounter('achievementProbability', forecast.probability, 0, '%');
  setText('controlCurrentWeight', forecast.currentWeight.toFixed(1) + 'kg');
  setText('controlLossFromStart', formatSignedLoss(forecast.lossFromStart));
  setText('controlRequiredPace', forecast.requiredWeeklyPace.toFixed(2) + 'kg/週');
  setText('controlActualPace', formatWeeklyLossPace(forecast.actualWeeklyPace));
  setText('controlProjectedWeight', forecast.projectedWeight.toFixed(1) + 'kg');
  setText('controlDaysLeft', forecast.days + '日');
  setText('forecastConfidence', '信頼度：' + forecast.confidence + ' / ' + forecast.sampleCount + '回計測');
  setText('controlSummary',
    '今のトレンドが続くと締切時は' + forecast.projectedWeight.toFixed(1) + 'kg。必要ペース週' +
    forecast.requiredWeeklyPace.toFixed(2) + 'kgに対し、実績は' + formatWeeklyLossPace(forecast.actualWeeklyPace) + '。');

  const verdict = document.getElementById('controlVerdict');
  if (verdict) {
    verdict.textContent = forecast.verdict.label;
    verdict.className = 'verdict-chip ' + forecast.verdict.className;
  }
  const probabilityBar = document.getElementById('probabilityBar');
  if (probabilityBar) probabilityBar.style.width = forecast.probability + '%';

  const recentSteps = averageRecentValid(records, 'steps', 7);
  const stepGoal = numberOr(options.goals?.steps, 8000);
  setText('controlAction', buildControlAction({
    forecast,
    recentSteps,
    stepGoal,
  }));
}

function calculateGateForecast(records, options) {
  if (!isNumber(options.currentWeight) || !options.latestDate || !options.deadline) return null;
  const currentWeight = Number(options.currentWeight);
  const days = Math.max(0, Number(options.days) || 0);
  const gap = Math.max(0, currentWeight - Number(options.targetWeight));
  const requiredWeeklyPace = days > 0 ? gap / (days / 7) : 0;
  const lossFromStart = PROJECT_START_WEIGHT - currentWeight;
  const latestTime = Date.parse(options.latestDate + 'T00:00:00Z');
  const points = records
    .filter(record => isNumber(record.metrics?.weightKg))
    .map(record => ({
      date: record.date,
      time: Date.parse(record.date + 'T00:00:00Z'),
      weight: Number(record.metrics.weightKg),
    }))
    .filter(point => Number.isFinite(point.time) && latestTime - point.time <= (FORECAST_WINDOW_DAYS - 1) * 86400000)
    .sort((a, b) => a.time - b.time);

  if (points.length < 4) {
    return {
      currentWeight,
      days,
      lossFromStart,
      requiredWeeklyPace,
      actualWeeklyPace: 0,
      projectedWeight: currentWeight,
      probability: currentWeight <= Number(options.targetWeight) ? 97 : 25,
      sampleCount: points.length,
      confidence: '低',
      verdict: verdictForProbability(currentWeight <= Number(options.targetWeight) ? 97 : 25),
    };
  }

  const origin = points[0].time;
  const xs = points.map(point => (point.time - origin) / 86400000);
  const ys = points.map(point => point.weight);
  const xMean = mean(xs);
  const yMean = mean(ys);
  const sxx = xs.reduce((sum, value) => sum + Math.pow(value - xMean, 2), 0);
  const sxy = xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0);
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = yMean - slope * xMean;
  const deadlineX = (Date.parse(options.deadline + 'T00:00:00Z') - origin) / 86400000;
  const projectedWeight = intercept + slope * deadlineX;
  const residualSquares = xs.reduce((sum, value, index) => {
    const residual = ys[index] - (intercept + slope * value);
    return sum + residual * residual;
  }, 0);
  const residualDeviation = Math.max(0.15, Math.sqrt(residualSquares / Math.max(1, points.length - 2)));
  const predictionDeviation = residualDeviation * Math.sqrt(1 + 1 / points.length + Math.pow(deadlineX - xMean, 2) / Math.max(1, sxx));
  const zScore = (Number(options.targetWeight) - projectedWeight) / Math.max(0.2, predictionDeviation);
  const probability = Math.round(clamp(normalCdf(zScore) * 100, 3, 97));
  const spanDays = xs.at(-1) - xs[0];
  const confidence = points.length >= 10 && spanDays >= 10 ? '中' : '低';

  return {
    currentWeight,
    days,
    lossFromStart,
    requiredWeeklyPace,
    actualWeeklyPace: -slope * 7,
    projectedWeight,
    probability,
    sampleCount: points.length,
    confidence,
    verdict: verdictForProbability(probability),
  };
}

function verdictForProbability(probability) {
  if (probability >= 70) return { label: 'ON TRACK', className: 'is-on-track' };
  if (probability >= 40) return { label: 'WARNING', className: 'is-warning' };
  return { label: 'OFF TRACK', className: 'is-off-track' };
}

function buildControlAction({ forecast, recentSteps, stepGoal }) {
  const orders = [];
  if (forecast.actualWeeklyPace + 0.03 < forecast.requiredWeeklyPace) {
    orders.push('今週は週' + forecast.requiredWeeklyPace.toFixed(2) + 'kg減のラインへ戻す');
  } else {
    orders.push('今の減量ペースを7日間崩さない');
  }
  if (isNumber(recentSteps) && recentSteps < stepGoal) {
    orders.push('歩数平均' + Math.round(recentSteps).toLocaleString('ja-JP') + '歩を' + Math.round(stepGoal).toLocaleString('ja-JP') + '歩まで上げる');
  }
  return orders.join('。') + '。';
}

function averageRecentValid(records, key, limit) {
  const values = [...records].reverse()
    .map(record => record.metrics?.[key])
    .filter(isNumber)
    .slice(0, limit)
    .map(Number);
  return values.length ? mean(values) : null;
}

function formatSignedLoss(value) {
  if (!isNumber(value)) return '—';
  return (Number(value) >= 0 ? '-' : '+') + Math.abs(Number(value)).toFixed(1) + 'kg';
}

function formatWeeklyLossPace(value) {
  if (!isNumber(value)) return '—';
  const number = Number(value);
  return (number < 0 ? '+' : '-') + Math.abs(number).toFixed(2) + 'kg/週';
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const erf = sign * (1 - (((((coefficients[4] * t + coefficients[3]) * t + coefficients[2]) * t + coefficients[1]) * t + coefficients[0]) * t) * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hasAnyMetric(record) {
  return Object.values(record.metrics || {}).some(isNumber);
}

function formatNumber(value, decimals, suffix) {
  return Math.max(0, Number(value) || 0).toLocaleString('ja-JP', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + suffix;
}

function formatInteger(value) {
  return isNumber(value) ? Math.round(value).toLocaleString('ja-JP') : '—';
}

function formatWeight(value) {
  return isNumber(value) ? Number(value).toFixed(1) + 'kg' : '—';
}

function formatSignedWeight(value) {
  if (!isNumber(value)) return '—';
  const number = Number(value);
  return (number > 0 ? '+' : '') + number.toFixed(1) + 'kg';
}

function formatDeltaMarkup(value) {
  if (!isNumber(value)) return '<span class="record-delta is-flat">—</span>';
  const number = Number(value);
  const className = number < 0 ? 'is-down' : number > 0 ? 'is-up' : 'is-flat';
  return '<span class="record-delta ' + className + '">' + formatSignedWeight(number) + '</span>';
}

function monthLabel(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return year + '年' + monthNumber + '月';
}

function previousIsoDate(isoDate) {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function updateMovementEquivalents(weeklyPace, currentWeight) {
  const weight = isNumber(currentWeight) ? Number(currentWeight) : 80;
  const dailyEnergyEquivalent = Math.max(0, Number(weeklyPace) || 0) * 7200 / 7;
  const options = [
    ['walkingMinutes', 4],
    ['runningMinutes', 8],
    ['swimmingMinutes', 8],
    ['strengthMinutes', 3],
  ];
  options.forEach(([id, mets]) => {
    const caloriesPerMinute = mets * 3.5 * weight / 200;
    const minutes = dailyEnergyEquivalent > 0
      ? Math.max(5, Math.round((dailyEnergyEquivalent / caloriesPerMinute) / 5) * 5)
      : 0;
    setText(id, minutes > 0 ? '約' + minutes + '分' : '維持ペース');
  });
  setText('dailyPaceEnergy', weeklyPace > 0
    ? '週' + Number(weeklyPace).toFixed(2) + 'kgのペースを、4つの動きに変換'
    : '目標到達後の、心地よい維持ペース');
}

function shortDate(isoDate) {
  const date = new Date(isoDate + 'T00:00:00Z');
  return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).toUpperCase();
}

function daysBetween(startIso, endIso) {
  const start = Date.parse(startIso + 'T00:00:00Z');
  const end = Date.parse(endIso + 'T00:00:00Z');
  return Math.max(0, Math.ceil((end - start) / 86400000));
}

function numberOr(value, fallback) {
  return isNumber(value) ? Number(value) : fallback;
}

function isNumber(value) {
  return Number.isFinite(Number(value)) && value !== null && value !== '';
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

renderRecords(FALLBACK_RECORDS);
setupReveals();
setupCounters();
const weightChart = setupWeightChart(FALLBACK_SERIES);
refreshDashboard(weightChart);
