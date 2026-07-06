const metrics = {
  sleepHours: { label: '睡眠', unit: 'h', color: '#2563eb', format: v => v == null ? '-' : hours(v) },
  steps: { label: '歩数', unit: '歩', color: '#0f9f6e', format: v => v == null ? '-' : Math.round(v).toLocaleString('ja-JP') + '歩' },
  activeEnergyKcal: { label: '活動kcal', unit: 'kcal', color: '#f59e0b', format: v => v == null ? '-' : Math.round(v) + 'kcal' },
  weightKg: { label: '体重', unit: 'kg', color: '#7c3aed', format: v => v == null ? '-' : v.toFixed(1) + 'kg' },
  bodyFatPercent: { label: '体脂肪', unit: '%', color: '#dc2626', format: v => v == null ? '-' : v.toFixed(1) + '%' },
};

let records = [];
let selectedMetric = 'weightKg';

fetch('./health-data.json')
  .then(res => res.json())
  .then(data => {
    records = data.records || [];
    render(data);
  });

function render(data) {
  const latest = [...records].reverse().find(r => hasAnyMetric(r)) || records.at(-1);
  document.getElementById('summary').textContent = data.generatedAt
    ? '更新: ' + new Date(data.generatedAt).toLocaleString('ja-JP') + ' / ' + data.recordCount + '日分'
    : '';
  renderKpis(latest);
  renderTabs();
  renderChart();
  renderWeightGoal(latest);
  renderStatus();
  renderTable();
}

function renderKpis(record) {
  const items = [
    ['睡眠', metrics.sleepHours.format(record?.metrics?.sleepHours), avgText(record, 'sleepHours')],
    ['歩数', metrics.steps.format(record?.metrics?.steps), avgText(record, 'steps')],
    ['活動', metrics.activeEnergyKcal.format(record?.metrics?.activeEnergyKcal), avgText(record, 'activeEnergyKcal')],
    ['体重', metrics.weightKg.format(record?.metrics?.weightKg), avgText(record, 'weightKg')],
    ['体脂肪', metrics.bodyFatPercent.format(record?.metrics?.bodyFatPercent), avgText(record, 'bodyFatPercent')],
  ];
  document.getElementById('kpis').innerHTML = items.map(([label, value, sub]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>
  `).join('');
}

function renderTabs() {
  document.getElementById('metricTabs').innerHTML = Object.entries(metrics).map(([key, meta]) => `
    <button class="tab ${key === selectedMetric ? 'active' : ''}" data-key="${key}">${meta.label}</button>
  `).join('');
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedMetric = btn.dataset.key;
      renderTabs();
      renderChart();
    });
  });
}

function renderChart() {
  const meta = metrics[selectedMetric];
  const rows = records.filter(r => r.metrics?.[selectedMetric] != null);
  const values = rows.map(r => r.metrics[selectedMetric]);
  const chart = document.getElementById('chart');
  if (!values.length) {
    chart.innerHTML = '<p class="bad">データなし</p>';
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max === min ? 1 : (max - min) * 0.15;
  const lo = min - pad;
  const hi = max + pad;
  const width = 900;
  const height = 280;
  const left = 54;
  const right = 18;
  const top = 20;
  const bottom = 42;
  const x = i => left + i * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = v => top + (hi - v) * ((height - top - bottom) / Math.max(1, hi - lo));
  const points = rows.map((r, i) => [x(i), y(r.metrics[selectedMetric]), r]);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const labels = rows.map((r, i) => i % Math.ceil(rows.length / 8) === 0 || i === rows.length - 1
    ? `<text x="${x(i)}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#647084">${r.date.slice(5)}</text>`
    : '').join('');
  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${meta.label} chart">
      <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" stroke="#dce2ea"/>
      <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#dce2ea"/>
      <text x="8" y="${top + 6}" font-size="11" fill="#647084">${meta.format(max)}</text>
      <text x="8" y="${height - bottom}" font-size="11" fill="#647084">${meta.format(min)}</text>
      <path d="${path}" fill="none" stroke="${meta.color}" stroke-width="3"/>
      ${points.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="4" fill="${meta.color}"><title>${r.date}: ${meta.format(r.metrics[selectedMetric])}</title></circle>`).join('')}
      ${labels}
    </svg>
  `;
}

function renderWeightGoal(record) {
  const weight = record?.metrics?.weightKg;
  const target = record?.goal?.weightTargetKg || 79;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / (start - target)) * 100));
  document.getElementById('weightGoal').innerHTML = `
    <div class="status-list">
      <div class="status-item"><span>現在</span><strong>${metrics.weightKg.format(weight)}</strong></div>
      <div class="status-item"><span>目標</span><strong>${target.toFixed(1)}kg</strong></div>
      <div class="status-item"><span>残り</span><strong>${weight == null ? '-' : (weight - target).toFixed(1) + 'kg'}</strong></div>
      <div class="progress"><span style="width:${progress}%"></span></div>
    </div>
  `;
}

function renderStatus() {
  const total = records.length;
  const generated = records.filter(r => r.status === 'posted_or_generated').length;
  const notReady = records.filter(r => r.status === 'not_ready').length;
  const bodyOnly = records.filter(r => r.status === 'body_only').length;
  document.getElementById('dataStatus').innerHTML = `
    <div class="status-list">
      <div class="status-item"><span>対象日数</span><strong>${total}</strong></div>
      <div class="status-item"><span>レポート生成済み</span><strong class="ok">${generated}</strong></div>
      <div class="status-item"><span>準備不足</span><strong class="warn">${notReady}</strong></div>
      <div class="status-item"><span>体組成のみ</span><strong>${bodyOnly}</strong></div>
    </div>
  `;
}

function renderTable() {
  document.getElementById('dailyRows').innerHTML = [...records].reverse().map(r => `
    <tr>
      <td>${r.date}</td>
      <td>${statusLabel(r.status)}</td>
      <td>${metrics.sleepHours.format(r.metrics.sleepHours)}</td>
      <td>${metrics.steps.format(r.metrics.steps)}</td>
      <td>${metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal)}</td>
      <td>${metrics.weightKg.format(r.metrics.weightKg)}</td>
      <td>${metrics.bodyFatPercent.format(r.metrics.bodyFatPercent)}</td>
      <td>${(r.missing || []).join(', ') || '-'}</td>
    </tr>
  `).join('');
}

function avgText(record, key) {
  const avg = record?.average7?.[key];
  if (avg == null) return '7日平均なし';
  return '7日平均 ' + metrics[key].format(avg);
}

function statusLabel(status) {
  if (status === 'posted_or_generated') return '<span class="ok">生成済み</span>';
  if (status === 'not_ready') return '<span class="warn">準備不足</span>';
  if (status === 'body_only') return '体組成のみ';
  return '-';
}

function hasAnyMetric(record) {
  return record && Object.values(record.metrics || {}).some(v => v != null);
}

function hours(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const mins = Math.round(Number(value) * 60);
  return Math.floor(mins / 60) + '時間' + String(mins % 60).padStart(2, '0') + '分';
}