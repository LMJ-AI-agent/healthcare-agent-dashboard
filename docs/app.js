const WEIGHT_VALUES = [80.7, 81.9, 80.2, 81.7, 82.2, 81.2, 80.7, 82.7, 80.4, 81.7, 82.6, 81.7];
const RECORDS = [
  ['07.22', '—', '—', '81.7', '27.7'],
  ['07.19', '6,545', '1,052', '82.6', '27.5'],
  ['07.17', '4,110', '383', '81.7', '28.2'],
  ['07.16', '3,677', '309', '81.2', '27.0'],
  ['07.14', '—', '—', '80.4', '27.8'],
  ['07.12', '4,338', '183', '82.7', '28.4'],
];

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const format = value => Math.max(0, value).toLocaleString('ja-JP', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + suffix;
  if (reduceMotion || !Number.isFinite(target)) {
    element.textContent = format(target);
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
    element.textContent = format(target * eased);
    if (progress < 1) requestAnimationFrame(tick);
    else {
      element.textContent = format(target);
      window.setTimeout(() => element.classList.remove('is-popping'), 420);
    }
  };
  requestAnimationFrame(tick);
}

function setupWeightChart() {
  const canvas = document.getElementById('weightTrendCanvas');
  if (!canvas) return;
  let frame = 0;
  let finished = false;

  const draw = progress => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(pixelRatio, pixelRatio);
    context.clearRect(0, 0, width, height);
    context.save();
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();

    const yMin = 79.8;
    const yMax = 83;
    const points = WEIGHT_VALUES.map((value, index) => ({
      x: (index / (WEIGHT_VALUES.length - 1)) * width,
      y: Math.max(0, Math.min(height, ((yMax - value) / (yMax - yMin)) * height)),
    }));
    const travel = Math.min(Math.max(progress, 0), 1) * (points.length - 1);
    const whole = Math.floor(travel);
    const fraction = travel - whole;
    const visible = points.slice(0, whole + 1);
    if (whole < points.length - 1) {
      const current = points[whole];
      const next = points[whole + 1];
      visible.push({
        x: current.x + (next.x - current.x) * fraction,
        y: current.y + (next.y - current.y) * fraction,
      });
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
  };

  const resizeObserver = new ResizeObserver(() => draw(finished ? 1 : 0));
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
      const progress = Math.min((now - start) / 1200, 1);
      draw(1 - Math.pow(1 - progress, 3));
      if (progress < 1) frame = requestAnimationFrame(animate);
      else finished = true;
    };
    frame = requestAnimationFrame(animate);
  }, { threshold: 0.35 });
  observer.observe(canvas);
}

function renderRecords() {
  const container = document.getElementById('recordsTable');
  if (!container) return;
  const header = '<div class="record-row record-header"><span>DATE</span><span>STEPS</span><span>ACTIVE KCAL</span><span>WEIGHT</span><span>BODY FAT</span></div>';
  const rows = RECORDS.map(record => '<div class="record-row">' +
    '<span data-label="DATE"><b>2026.</b>' + record[0] + '</span>' +
    '<span data-label="STEPS">' + record[1] + '</span>' +
    '<span data-label="ACTIVE KCAL">' + record[2] + '</span>' +
    '<span data-label="WEIGHT"><strong>' + record[3] + '</strong> kg</span>' +
    '<span data-label="BODY FAT">' + record[4] + ' %</span>' +
    '</div>').join('');
  container.innerHTML = header + rows;
}

renderRecords();
setupReveals();
setupCounters();
setupWeightChart();
