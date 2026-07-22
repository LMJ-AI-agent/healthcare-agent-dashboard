const DEFAULT_GOALS = { weightKg: 79, deadline: '2026-07-31', steps: 8000, sleepHours: 6.5, activeEnergyKcal: 650, bodyFatPercent: 25 };
let GOALS = loadGoalSettings();
const metrics = {
  weightKg: { label: '体重', color: '#3567e8', format: v => v == null ? '-' : v.toFixed(1) + 'kg' },
  bodyFatPercent: { label: '体脂肪率', color: '#df4b4b', format: v => v == null ? '-' : v.toFixed(1) + '%' },
  sleepHours: { label: '睡眠', color: '#7c5cff', format: v => v == null ? '-' : hours(v) },
  steps: { label: '歩数', color: '#15956b', format: v => v == null ? '-' : Math.round(v).toLocaleString('ja-JP') + '歩' },
  activeEnergyKcal: { label: '活動kcal', color: '#f29f3d', format: v => v == null ? '-' : Math.round(v) + 'kcal' },
};
const TASK_TITLES = ['活動量', '筋トレ', '食事', '減量ペース'];
let records = [];
let selectedMetric = 'weightKg';
let latestRecord = null;
let todayPlan = [];
let dayState = null;
let themeStore = null;
let dashboardData = null;

fetch('./health-data.json')
  .then(res => res.json())
  .then(data => {
    dashboardData = data;
    records = data.records || [];
    latestRecord = [...records].reverse().find(r => hasAnyMetric(r)) || records.at(-1);
    dayState = loadDayState(latestRecord?.date || todayIso());
    themeStore = loadThemeStore();
    render(data);
  });

function render(data) {
  const m = latestRecord?.metrics || {};
  const kgLeft = m.weightKg == null ? null : m.weightKg - GOALS.weightKg;
  todayPlan = buildTodayPlan(latestRecord);
  document.getElementById('heroLead').textContent = data.generatedAt
    ? '更新: ' + new Date(data.generatedAt).toLocaleString('ja-JP') + ' / ' + data.recordCount + '日分。チェックして進めるほど、今日のログと達成率が育ちます。'
    : '';
  renderHeroMetrics(latestRecord, kgLeft);
  renderGoalManager(latestRecord);
  renderCompletionSummary();
  renderCoaching();
  renderActionDetails();
  renderRadar(latestRecord);
  renderKpis(latestRecord);
  renderStrengthPlan();
  renderDietPlan();
  renderMemo();
  renderTabs();
  renderChart();
  renderWeightGoal(latestRecord);
  renderCompletionLog();
  renderThemeStock();
  renderTable();
  bindReset();
  bindThemeStock();
}

function buildTodayPlan(record) {
  const actions = record?.coaching?.actions?.length ? record.coaching.actions : ['体重・睡眠・歩数のデータ取得状態を確認する。'];
  const m = record?.metrics || {};
  const tired = m.sleepHours == null || m.sleepHours < 6;
  const strengthItems = tired
    ? [
        ['回復日メニュー', 'スクワット10回 x 2、壁腕立て10回 x 2、プランク20秒 x 2'],
        ['フォーム確認', '息が上がりすぎない強度で、動きを丁寧に確認する'],
      ]
    : [
        ['下半身', 'スクワット10回 x 3、ヒップヒンジ12回 x 3'],
        ['上半身', '腕立て8回 x 3、ローイング12回 x 3'],
        ['体幹', 'プランク30秒 x 3、デッドバグ左右10回 x 2'],
      ];
  const dietItems = [
    ['朝', 'たんぱく質を先に入れる。卵・ヨーグルト・鶏肉・魚のどれかを選ぶ'],
    ['昼', '主食はゼロにしない。量を固定して、揚げ物と甘い飲み物を避ける'],
    ['夜', '遅い時間は脂質を軽くする。米を減らすより、間食を先に削る'],
    ['今日の調整', m.steps == null || m.steps < GOALS.steps ? '夜の間食はなし。歩数不足は食事で取り返す' : '無理な食事制限をしない。たんぱく質を優先'],
  ];
  return [
    ...actions.map((text, i) => ({ id: 'coach-' + i, group: 'today', title: TASK_TITLES[i] || '今日の指示', text })),
    ...strengthItems.map(([title, text], i) => ({ id: 'strength-' + i, group: 'strength', title, text })),
    ...dietItems.map(([title, text], i) => ({ id: 'diet-' + i, group: 'diet', title, text })),
  ];
}

function renderHeroMetrics(record, kgLeft) {
  const m = record?.metrics || {};
  const seven = record?.coaching?.sevenDay || {};
  const completed = completedCount();
  const total = todayPlan.length;
  const cards = [
    ['今日の完了', completed + '/' + total, completionRate() + '% 達成'],
    ['現在体重', metrics.weightKg.format(m.weightKg), kgLeft == null ? targetDeadlineText() : targetDeadlineText() + ' / 残り' + kgLeft.toFixed(1) + 'kg'],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), seven.bodyFatPercent == null ? '7日平均なし' : '7日平均 ' + seven.bodyFatPercent.toFixed(1) + '%'],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), seven.sleepHours == null ? '7日平均なし' : '7日平均 ' + hours(seven.sleepHours)],
  ];
  document.getElementById('heroMetrics').innerHTML = cards.map(([label, value, sub]) =>
    '<div class="hero-card"><span>' + label + '</span><strong>' + value + '</strong><small>' + sub + '</small></div>'
  ).join('');
}

function renderGoalManager(record) {
  const m = record?.metrics || {};
  const weight = m.weightKg;
  const kgLeft = weight == null ? null : round1(weight - GOALS.weightKg);
  const daysLeft = daysUntil(GOALS.deadline);
  const pace = kgLeft == null || daysLeft == null || kgLeft <= 0 ? null : round2(kgLeft / Math.max(1, daysLeft) * 7);
  const progress = weight == null ? 0 : clamp(((84 - weight) / Math.max(.1, 84 - GOALS.weightKg)) * 100, 0, 100);
  document.getElementById('goalOverview').innerHTML =
    '<div class="goal-overview-grid">' +
    '<div class="goal-stat primary"><span>現在</span><strong>' + metrics.weightKg.format(weight) + '</strong><small>目標 ' + GOALS.weightKg.toFixed(1) + 'kg</small></div>' +
    '<div class="goal-stat"><span>残り</span><strong>' + (kgLeft == null ? '-' : Math.max(0, kgLeft).toFixed(1) + 'kg') + '</strong><small>' + targetDeadlineText() + '</small></div>' +
    '<div class="goal-stat"><span>期限</span><strong>' + (daysLeft == null ? '-' : daysLeft + '日') + '</strong><small>' + (pace == null ? '達成後は維持フェーズ' : '週' + pace.toFixed(2) + 'kgペース') + '</small></div>' +
    '<div class="goal-progress"><span style="width:' + progress + '%"></span></div>' +
    '</div>';
  document.getElementById('goalWeightInput').value = GOALS.weightKg;
  document.getElementById('goalDeadlineInput').value = GOALS.deadline;
  document.getElementById('goalStepsInput').value = GOALS.steps;
  document.getElementById('goalSleepInput').value = GOALS.sleepHours;
  document.getElementById('goalBodyFatInput').value = GOALS.bodyFatPercent;
  document.querySelectorAll('.goal-form input').forEach(input => {
    input.oninput = () => { document.getElementById('goalSaveStatus').textContent = '未保存の変更あり'; };
  });
  document.getElementById('saveGoals').onclick = saveGoalsFromInputs;
  document.getElementById('resetGoals').onclick = resetGoals;
}

function renderCompletionSummary() {
  const rate = completionRate();
  const completed = completedCount();
  const total = todayPlan.length;
  const activeTheme = currentThemeText();
  document.getElementById('todayScore').textContent = '今日の指示 ' + completed + '/' + total + ' 完了';
  document.getElementById('motivationLine').textContent = activeTheme || (rate >= 80 ? '最高です。この調子でいこう。' : rate >= 40 ? 'かなり進んでいます。あと少し。' : 'まず1つ押そう。流れができます。');
  document.getElementById('victoryTitle').textContent = rate >= 100 ? '今日の指示 ' + completed + '/' + total + ' 完了。素晴らしいです！' : '今日の指示 ' + completed + '/' + total + ' 完了';
  document.getElementById('completionRing').innerHTML = ringSvg(rate);
}

function renderCoaching() {
  document.getElementById('topPriority').textContent = latestRecord?.coaching?.topPriority || 'データ確認';
  const items = todayPlan.filter(item => item.group === 'today');
  const completed = items.filter(item => dayState.tasks[item.id]).length;
  const total = items.length;
  const allCompleted = completedCount();
  const allTotal = todayPlan.length;
  document.getElementById('coachActions').innerHTML =
    '<div class="summary-grid">' +
    '<div class="summary-card"><span>今日の指示</span><strong>' + completed + '/' + total + '</strong><small>細かい実行内容は下の「実行項目」で管理します。</small></div>' +
    '<div class="summary-card"><span>達成率</span><strong>' + allCompleted + '/' + allTotal + '</strong><small>全タスク合計: ' + completionRate() + '% 完了</small></div>' +
    '<div class="summary-card"><span>次の一手</span><strong>' + nextTaskLabel() + '</strong><small>完了した項目はログへ自動反映されます。</small></div>' +
    '</div>';
}

function renderActionDetails() {
  const items = todayPlan.filter(item => item.group === 'today');
  const done = items.filter(item => dayState.tasks[item.id]).length;
  document.getElementById('actionDetailCount').textContent = done + '/' + items.length + ' 完了';
  document.getElementById('actionDetails').innerHTML = items.length
    ? '<div class="action-detail-grid">' + items.map(item => taskCard(item)).join('') + '</div>'
    : '<div class="status-list"><div class="status-item"><span>実行項目</span><strong>データ更新待ち</strong></div></div>';
  bindTaskButtons();
}

function renderStrengthPlan() {
  const items = todayPlan.filter(item => item.group === 'strength');
  document.getElementById('strengthPlan').innerHTML = '<div class="plan-stack">' + items.map(item => taskCard(item, true)).join('') + '</div>';
  bindTaskButtons();
}

function renderDietPlan() {
  const items = todayPlan.filter(item => item.group === 'diet');
  document.getElementById('dietPlan').innerHTML = '<div class="plan-stack">' + items.map(item => taskCard(item, true)).join('') + '</div>';
  bindTaskButtons();
}

function taskCard(item, compact = false) {
  const done = !!dayState.tasks[item.id];
  return '<div class="' + (compact ? 'plan-card' : 'task-card') + (done ? ' done' : '') + '" data-task-id="' + item.id + '">' +
    '<div class="task-row">' +
    '<button class="check-button" type="button" data-task-id="' + item.id + '" aria-label="' + escapeHtml(item.title) + 'を完了">' + (done ? '✓' : '') + '</button>' +
    '<div><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.text) + '</p></div>' +
    '<span class="tag">' + (done ? '完了' : '未完了') + '</span>' +
    '</div></div>';
}

function bindTaskButtons() {
  document.querySelectorAll('.task-card[data-task-id], .plan-card[data-task-id]').forEach(card => {
    card.onclick = () => toggleTask(card.dataset.taskId);
  });
  document.querySelectorAll('.check-button').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      toggleTask(button.dataset.taskId);
    };
  });
}

function toggleTask(id) {
  dayState.tasks[id] = !dayState.tasks[id];
  saveDayState();
  showFeedback(dayState.tasks[id] ? '素晴らしいです！1つ前進しました。' : '未完了に戻しました。調整OKです。');
  renderAfterStateChange();
}

function renderAfterStateChange() {
  renderCompletionSummary();
  renderHeroMetrics(latestRecord, latestRecord?.metrics?.weightKg == null ? null : latestRecord.metrics.weightKg - GOALS.weightKg);
  renderCoaching();
  renderActionDetails();
  renderStrengthPlan();
  renderDietPlan();
  renderCompletionLog();
  renderTable();
}

function renderMemo() {
  const memo = document.getElementById('workoutMemo');
  memo.value = dayState.memo || '';
  memo.oninput = () => {
    dayState.memo = memo.value;
    saveDayState();
    document.getElementById('memoSaved').textContent = '保存しました ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    renderCompletionLog();
  };
}

function bindReset() {
  document.getElementById('clearToday').onclick = () => {
    dayState = { date: dayState.date, tasks: {}, memo: '' };
    saveDayState();
    render(dataPlaceholder());
    showFeedback('今日のチェックをリセットしました。');
  };
}

function renderThemeStock() {
  const themes = themeStore?.themes || [];
  const activeId = themeStore?.activeId || null;
  document.getElementById('themeCount').textContent = themes.length + '件ストック';
  document.getElementById('themeStock').innerHTML = themes.length
    ? '<div class="theme-list">' + themes.map(theme => (
      '<div class="theme-card ' + (theme.id === activeId ? 'active' : '') + '" data-theme-id="' + theme.id + '">' +
      '<div><strong>' + escapeHtml(theme.text) + '</strong><small>' + new Date(theme.createdAt).toLocaleString('ja-JP') + (theme.id === activeId ? ' / 今のテーマ' : '') + '</small></div>' +
      '<div class="theme-actions">' +
      '<button class="primary" type="button" data-theme-action="activate" data-theme-id="' + theme.id + '">今のテーマにする</button>' +
      '<button type="button" data-theme-action="delete" data-theme-id="' + theme.id + '">削除</button>' +
      '</div></div>'
    )).join('') + '</div>'
    : '<div class="status-list"><div class="status-item"><span>ストック</span><strong>まだありません</strong></div></div>';
}

function bindThemeStock() {
  document.getElementById('addTheme').onclick = () => addThemeFromInput();
  document.getElementById('themeInput').onkeydown = event => {
    if (event.key === 'Enter') addThemeFromInput();
  };
  document.querySelectorAll('[data-theme-action]').forEach(button => {
    button.onclick = () => {
      if (button.dataset.themeAction === 'activate') activateTheme(button.dataset.themeId);
      if (button.dataset.themeAction === 'delete') deleteTheme(button.dataset.themeId);
    };
  });
}

function addThemeFromInput() {
  const input = document.getElementById('themeInput');
  const text = input.value.trim();
  if (!text) return;
  const theme = { id: 'theme-' + Date.now(), text, createdAt: new Date().toISOString() };
  themeStore.themes.unshift(theme);
  themeStore.activeId = theme.id;
  saveThemeStore();
  input.value = '';
  showFeedback('今後のテーマとしてストックしました。');
  renderCompletionSummary();
  renderThemeStock();
  bindThemeStock();
}

function activateTheme(id) {
  themeStore.activeId = id;
  saveThemeStore();
  showFeedback('今のテーマに設定しました。');
  renderCompletionSummary();
  renderThemeStock();
  bindThemeStock();
}

function deleteTheme(id) {
  themeStore.themes = themeStore.themes.filter(theme => theme.id !== id);
  if (themeStore.activeId === id) themeStore.activeId = themeStore.themes[0]?.id || null;
  saveThemeStore();
  showFeedback('テーマを削除しました。');
  renderCompletionSummary();
  renderThemeStock();
  bindThemeStock();
}

function currentThemeText() {
  const active = (themeStore?.themes || []).find(theme => theme.id === themeStore.activeId);
  return active ? '今のテーマ: ' + active.text : '';
}

function renderCompletionLog() {
  const doneItems = todayPlan.filter(item => dayState.tasks[item.id]);
  document.getElementById('completionLog').innerHTML =
    '<div class="status-list">' +
    '<div class="status-item"><span>今日の実績</span><strong>' + completedCount() + '/' + todayPlan.length + ' 完了</strong></div>' +
    '<div class="status-item"><span>達成率</span><strong>' + completionRate() + '%</strong></div>' +
    '<div class="status-item"><span>完了項目</span><strong>' + (doneItems.length ? doneItems.map(i => i.title).join('、') : 'まだなし') + '</strong></div>' +
    '<div class="status-item"><span>筋トレメモ</span><strong>' + (dayState.memo ? escapeHtml(dayState.memo.slice(0, 42)) : '未入力') + '</strong></div>' +
    '</div>';
}

function renderRadar(record) {
  const scores = buildScores(record);
  const labels = scores.map(s => s.label);
  const values = scores.map(s => s.score);
  const cx = 150, cy = 150, maxR = 104;
  const points = values.map((score, i) => point(cx, cy, maxR * score / 100, i, values.length));
  const grid = [20,40,60,80,100].map(level => '<polygon points="' + values.map((_, i) => point(cx, cy, maxR * level / 100, i, values.length).join(',')).join(' ') + '" fill="none" stroke="#dfe6df" stroke-width="1"/>').join('');
  const axis = labels.map((label, i) => {
    const end = point(cx, cy, maxR, i, labels.length);
    const text = point(cx, cy, maxR + 22, i, labels.length);
    return '<line x1="' + cx + '" y1="' + cy + '" x2="' + end[0] + '" y2="' + end[1] + '" stroke="#dfe6df"/><text x="' + text[0] + '" y="' + text[1] + '" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#66736d">' + label + '</text>';
  }).join('');
  document.getElementById('radar').innerHTML =
    '<div class="radar-layout"><svg viewBox="0 0 300 300" role="img" aria-label="5角形パラメータ">' + grid + axis +
    '<polygon points="' + points.map(p => p.join(',')).join(' ') + '" fill="rgba(21,149,107,.24)" stroke="#15956b" stroke-width="3"/>' +
    points.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#12261f"/>').join('') +
    '</svg><div class="score-list">' + scores.map(s => '<div class="score-row"><span>' + s.label + '</span><div class="mini-bar"><span style="width:' + s.score + '%"></span></div><strong>' + s.score + '</strong></div>').join('') + '</div></div>';
}

function buildScores(record) {
  const m = record?.metrics || {};
  return [
    { label: '減量', score: clamp(100 - Math.max(0, (m.weightKg ?? 84) - GOALS.weightKg) * 12, 0, 100) },
    { label: '活動', score: clamp(((m.steps ?? 0) / GOALS.steps) * 100, 0, 100) },
    { label: '睡眠', score: clamp(((m.sleepHours ?? 0) / GOALS.sleepHours) * 100, 0, 100) },
    { label: '体脂肪', score: clamp(100 - Math.max(0, (m.bodyFatPercent ?? 32) - GOALS.bodyFatPercent) * 9, 0, 100) },
    { label: '実行', score: completionRate() },
  ].map(s => ({ ...s, score: Math.round(s.score) }));
}

function renderKpis(record) {
  const m = record?.metrics || {};
  const c = record?.coaching || {};
  const items = [
    ['体重', metrics.weightKg.format(m.weightKg), goalText(m.weightKg, GOALS.weightKg, 'kg')],
    ['体脂肪率', metrics.bodyFatPercent.format(m.bodyFatPercent), deltaText(c.deltas?.bodyFatPercent, '%')],
    ['睡眠', metrics.sleepHours.format(m.sleepHours), deltaText(c.deltas?.sleepHours, 'h')],
    ['歩数', metrics.steps.format(m.steps), targetText(m.steps, GOALS.steps, '歩')],
    ['活動量', metrics.activeEnergyKcal.format(m.activeEnergyKcal), targetText(m.activeEnergyKcal, GOALS.activeEnergyKcal, 'kcal')],
  ];
  document.getElementById('kpis').innerHTML = items.map(([label, value, sub]) =>
    '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + sub + '</div></div>'
  ).join('');
}

function renderTabs() {
  document.getElementById('metricTabs').innerHTML = Object.entries(metrics).map(([key, meta]) =>
    '<button class="tab ' + (key === selectedMetric ? 'active' : '') + '" data-key="' + key + '">' + meta.label + '</button>'
  ).join('');
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => { selectedMetric = btn.dataset.key; renderTabs(); renderChart(); });
  });
}

function renderChart() {
  const meta = metrics[selectedMetric];
  const rows = records.filter(r => r.metrics?.[selectedMetric] != null);
  const values = rows.map(r => r.metrics[selectedMetric]);
  const chart = document.getElementById('chart');
  if (!values.length) { chart.innerHTML = '<p class="bad">この項目のデータがありません</p>'; return; }
  const min = Math.min(...values), max = Math.max(...values);
  const pad = max === min ? 1 : (max - min) * 0.15;
  const lo = min - pad, hi = max + pad;
  const width = 940, height = 310, left = 56, right = 20, top = 22, bottom = 44;
  const x = i => left + i * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = v => top + (hi - v) * ((height - top - bottom) / Math.max(1, hi - lo));
  const points = rows.map((r, i) => [x(i), y(r.metrics[selectedMetric]), r]);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = path + ' L' + points.at(-1)[0].toFixed(1) + ',' + (height - bottom) + ' L' + points[0][0].toFixed(1) + ',' + (height - bottom) + ' Z';
  const labels = rows.map((r, i) => i % Math.ceil(rows.length / 8) === 0 || i === rows.length - 1 ? '<text x="' + x(i) + '" y="' + (height - 13) + '" text-anchor="middle" font-size="11" fill="#66736d">' + r.date.slice(5) + '</text>' : '').join('');
  chart.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + meta.label + ' chart">' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<line x1="' + left + '" y1="' + (height - bottom) + '" x2="' + (width - right) + '" y2="' + (height - bottom) + '" stroke="#dfe6df"/>' +
    '<path d="' + area + '" fill="' + meta.color + '" opacity=".11"/>' +
    '<path d="' + path + '" fill="none" stroke="' + meta.color + '" stroke-width="3.5"/>' +
    points.map(([cx, cy, r]) => '<circle cx="' + cx + '" cy="' + cy + '" r="4.5" fill="#fff" stroke="' + meta.color + '" stroke-width="3"><title>' + r.date + ': ' + meta.format(r.metrics[selectedMetric]) + '</title></circle>').join('') +
    '<text x="8" y="' + (top + 6) + '" font-size="11" fill="#66736d">' + meta.format(max) + '</text>' +
    '<text x="8" y="' + (height - bottom) + '" font-size="11" fill="#66736d">' + meta.format(min) + '</text>' + labels + '</svg>';
}

function renderWeightGoal(record) {
  const weight = record?.metrics?.weightKg;
  const target = GOALS.weightKg;
  const start = Math.max(weight || target, 84);
  const progress = weight == null ? 0 : Math.max(0, Math.min(100, ((start - weight) / Math.max(.1, start - target)) * 100));
  document.getElementById('weightGoal').innerHTML =
    '<div class="status-list">' +
    '<div class="status-item"><span>現在</span><strong>' + metrics.weightKg.format(weight) + '</strong></div>' +
    '<div class="status-item"><span>目標</span><strong>' + target.toFixed(1) + 'kg</strong></div>' +
    '<div class="status-item"><span>期限</span><strong>' + targetDeadlineText() + '</strong></div>' +
    '<div class="status-item"><span>残り</span><strong>' + (weight == null ? '-' : (weight - target).toFixed(1) + 'kg') + '</strong></div>' +
    '<div class="status-item"><span>推奨ペース</span><strong>2週間で1kg減</strong></div>' +
    '<div class="progress"><span style="width:' + progress + '%"></span></div>' +
    '</div>';
}

function renderTable() {
  document.getElementById('dailyRows').innerHTML = [...records].reverse().map(r => {
    const state = loadDayState(r.date);
    const total = r.date === latestRecord?.date ? todayPlan.length : Object.keys(state.tasks || {}).length;
    const done = Object.values(state.tasks || {}).filter(Boolean).length;
    return '<tr><td>' + r.date + '</td><td>' + done + '/' + total + '</td><td>' + metrics.sleepHours.format(r.metrics.sleepHours) + '</td><td>' + metrics.steps.format(r.metrics.steps) + '</td><td>' + metrics.activeEnergyKcal.format(r.metrics.activeEnergyKcal) + '</td><td>' + metrics.weightKg.format(r.metrics.weightKg) + '</td><td>' + metrics.bodyFatPercent.format(r.metrics.bodyFatPercent) + '</td><td>' + (r.metrics.bodyMassIndex == null ? '-' : r.metrics.bodyMassIndex.toFixed(1)) + '</td></tr>';
  }).join('');
}

function loadDayState(date) {
  try {
    const raw = localStorage.getItem('dietCoach:' + date);
    return raw ? { date, tasks: {}, memo: '', ...JSON.parse(raw) } : { date, tasks: {}, memo: '' };
  } catch {
    return { date, tasks: {}, memo: '' };
  }
}
function saveDayState() { localStorage.setItem('dietCoach:' + dayState.date, JSON.stringify(dayState)); }
function loadThemeStore() {
  try {
    const raw = localStorage.getItem('dietCoach:themes');
    return raw ? { themes: [], activeId: null, ...JSON.parse(raw) } : { themes: [], activeId: null };
  } catch {
    return { themes: [], activeId: null };
  }
}
function saveThemeStore() { localStorage.setItem('dietCoach:themes', JSON.stringify(themeStore)); }
function loadGoalSettings() {
  try {
    const raw = localStorage.getItem('dietCoach:goals');
    return raw ? { ...DEFAULT_GOALS, ...JSON.parse(raw) } : { ...DEFAULT_GOALS };
  } catch {
    return { ...DEFAULT_GOALS };
  }
}
function saveGoalsFromInputs() {
  GOALS = {
    weightKg: numberFromInput('goalWeightInput', DEFAULT_GOALS.weightKg),
    deadline: document.getElementById('goalDeadlineInput').value || DEFAULT_GOALS.deadline,
    steps: Math.round(numberFromInput('goalStepsInput', DEFAULT_GOALS.steps)),
    sleepHours: numberFromInput('goalSleepInput', DEFAULT_GOALS.sleepHours),
    activeEnergyKcal: DEFAULT_GOALS.activeEnergyKcal,
    bodyFatPercent: numberFromInput('goalBodyFatInput', DEFAULT_GOALS.bodyFatPercent),
  };
  localStorage.setItem('dietCoach:goals', JSON.stringify(GOALS));
  document.getElementById('goalSaveStatus').textContent = '保存済み';
  todayPlan = buildTodayPlan(latestRecord);
  render(dashboardData || dataPlaceholder());
  showFeedback('目標値を保存して反映しました。');
}
function resetGoals() {
  GOALS = { ...DEFAULT_GOALS };
  localStorage.removeItem('dietCoach:goals');
  document.getElementById('goalSaveStatus').textContent = '初期値に戻しました';
  todayPlan = buildTodayPlan(latestRecord);
  render(dashboardData || dataPlaceholder());
  showFeedback('目標値を初期値に戻しました。');
}
function numberFromInput(id, fallback) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : fallback;
}
function completedCount() { return Object.values(dayState?.tasks || {}).filter(Boolean).length; }
function completionRate() { return todayPlan.length ? Math.round((completedCount() / todayPlan.length) * 100) : 0; }
function nextTaskLabel() {
  const next = todayPlan.find(item => !dayState?.tasks?.[item.id]);
  return next ? next.title : '全部完了';
}
function targetDeadlineText() { return formatDateJa(GOALS.deadline) + 'までに' + GOALS.weightKg.toFixed(1) + 'kg'; }
function daysUntil(isoDate) {
  const target = new Date(isoDate + 'T00:00:00+09:00');
  const now = new Date();
  if (Number.isNaN(target.getTime())) return null;
  return Math.max(0, Math.ceil((target - now) / 86400000));
}
function formatDateJa(isoDate) {
  const date = new Date(isoDate + 'T00:00:00+09:00');
  return Number.isNaN(date.getTime()) ? isoDate : date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}
function showFeedback(text) {
  const toast = document.getElementById('feedbackToast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showFeedback.timer);
  showFeedback.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}
function ringSvg(rate) {
  const r = 52, c = Math.PI * 2 * r, offset = c * (1 - rate / 100);
  return '<svg viewBox="0 0 138 138"><circle cx="69" cy="69" r="' + r + '" fill="none" stroke="#e8eee8" stroke-width="13"/><circle cx="69" cy="69" r="' + r + '" fill="none" stroke="#15956b" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 69 69)"/><text x="69" y="65" text-anchor="middle" font-size="28" font-weight="900" fill="#15201c">' + rate + '%</text><text x="69" y="88" text-anchor="middle" font-size="12" font-weight="800" fill="#66736d">完了</text></svg>';
}
function dataPlaceholder() { return { generatedAt: new Date().toISOString(), recordCount: records.length }; }
function point(cx, cy, r, index, total) { const angle = -Math.PI / 2 + index * 2 * Math.PI / total; return [Math.round((cx + Math.cos(angle) * r) * 10) / 10, Math.round((cy + Math.sin(angle) * r) * 10) / 10]; }
function goalText(value, target, unit) { if (value == null) return '目標 ' + target + unit; const diff = value - target; return diff <= 0 ? '目標達成' : '目標まであと' + diff.toFixed(1) + unit; }
function targetText(value, target, unit) { if (value == null) return '目標 ' + target.toLocaleString('ja-JP') + unit; const diff = value - target; return diff >= 0 ? '目標比 +' + Math.round(diff).toLocaleString('ja-JP') + unit : '目標まで ' + Math.abs(Math.round(diff)).toLocaleString('ja-JP') + unit; }
function deltaText(value, unit) { if (value == null) return '前回比データなし'; const sign = value > 0 ? '+' : ''; if (unit === 'h') return '前回比 ' + sign + value.toFixed(2) + '時間'; return '前回比 ' + sign + value.toFixed(unit === '%' ? 1 : 0) + unit; }
function hasAnyMetric(record) { return record && Object.values(record.metrics || {}).some(v => v != null); }
function hours(value) { if (value == null || !Number.isFinite(Number(value))) return '-'; const mins = Math.round(Number(value) * 60); return Math.floor(mins / 60) + '時間' + String(mins % 60).padStart(2, '0') + '分'; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function round1(value) { return Math.round(Number(value) * 10) / 10; }
function round2(value) { return Math.round(Number(value) * 100) / 100; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }