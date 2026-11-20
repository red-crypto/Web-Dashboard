// 개인 대시보드 프런트엔드 (빌드 도구 없이 순수 JS).
// 화면 전환은 주소의 #/... 로 한다. 모든 데이터는 서버 API(/api/...)를 통해 로컬 DB에 저장된다.
'use strict';

// ===================== 공통 도구 =====================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['일', '월', '화', '수', '목', '금', '토'];

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `요청 실패 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// 날짜 문자열 'YYYY-MM-DD' 도구 (시간대 영향 없도록 UTC로 계산)
const D = {
  parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); },
  fmt(dt) { return dt.toISOString().slice(0, 10); },
  add(s, n) { const d = D.parse(s); d.setUTCDate(d.getUTCDate() + n); return D.fmt(d); },
  wd(s) { return D.parse(s).getUTCDay(); },
  month(s) { return s.slice(0, 7); },
  addMonth(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return D.fmt(d).slice(0, 7); },
  long(s) { const [y, m, d] = s.split('-').map(Number); return `${y}년 ${m}월 ${d}일 ${WD[D.wd(s)]}요일`; },
  short(s) { const [, m, d] = s.split('-').map(Number); return `${m}/${d}(${WD[D.wd(s)]})`; },
  // 오늘 기준 상대 표현
  rel(s) {
    if (!s) return '';
    const t = today();
    if (s === t) return '오늘';
    if (s === D.add(t, 1)) return '내일';
    if (s === D.add(t, -1)) return '어제';
    return D.short(s);
  },
};

let settings = { timezone: 'Asia/Seoul' };
function today() {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
function fmtTime(e) {
  if (!e.start_time) return '종일';
  return e.end_time ? `${e.start_time}~${e.end_time}` : e.start_time;
}

// 렌더링한 항목을 id로 찾기 위한 캐시 (수정 모달용)
const cache = { todos: new Map(), events: new Map() };
const remember = (map, rows) => { rows.forEach((r) => map.set(r.id, r)); return rows; };

// ===================== 공통 조각 =====================
function todoItem(t) {
  cache.todos.set(t.id, t);
  const overdue = !t.done && t.due_date && t.due_date < today();
  const meta = [];
  if (t.due_date) meta.push(`<span class="tag ${overdue ? 'danger' : t.due_date === today() ? 'lime' : ''}">${overdue ? '지연 · ' : ''}${esc(D.rel(t.due_date))}</span>`);
  if (t.project_name) meta.push(`<span>${esc(t.project_name)}</span>`);
  return `<li class="todo ${t.done ? 'done' : ''} ${overdue ? 'overdue' : ''}">
    <button class="check" data-action="toggle-todo" data-id="${t.id}" aria-label="${t.done ? '완료 취소' : '완료'}">${t.done ? '✓' : ''}</button>
    <div class="body" data-action="edit-todo" data-id="${t.id}">
      <div class="title">${esc(t.title)}</div>
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
    </div>
  </li>`;
}

function eventItem(e) {
  cache.events.set(e.id, e);
  const [, m, d] = e.date.split('-').map(Number);
  return `<li class="event ${e.date === today() ? 'is-today' : ''}" data-action="edit-event" data-id="${e.id}">
    <div class="when"><div class="d">${d}</div><div class="m">${m}월 ${WD[D.wd(e.date)]}</div></div>
    <div class="info"><div class="title">${esc(e.title)}</div>
      <div class="meta">${esc(D.rel(e.date))} · ${esc(fmtTime(e))}${e.project_name ? ' · ' + esc(e.project_name) : ''}</div></div>
  </li>`;
}

function projectCard(p, { showGoal = false } = {}) {
  const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
  return `<a class="project-card" href="#/projects/${p.id}">
    <div class="top"><span class="name">${esc(p.name)}</span><span class="count"><b>${p.completed}</b> / ${p.total}</span></div>
    ${showGoal && p.goal ? `<div class="goal">${esc(p.goal)}</div>` : ''}
    <div class="progress"><span style="width:${pct}%"></span></div>
    <div class="next">${p.next ? `다음: <b>${esc(p.next.title)}</b>${p.next.due_date ? ` · ${esc(D.rel(p.next.due_date))}` : ''}` : (p.total ? '모든 할 일 완료 🎉' : '아직 할 일이 없어요')}</div>
    ${p.due_date || p.status !== 'active' ? `<div class="next" style="margin-top:6px">${p.status !== 'active' ? `<span class="tag">${STATUS_KO[p.status]}</span> ` : ''}${p.due_date ? `마감 ${esc(D.short(p.due_date))}` : ''}</div>` : ''}
  </a>`;
}
const STATUS_KO = { active: '진행 중', paused: '보류', done: '완료' };

function empty(text, btnLabel, action, extra = '') {
  return `<div class="empty"><div>${esc(text)}</div><button class="btn primary small" data-action="${action}" ${extra}>${esc(btnLabel)}</button></div>`;
}

// 미니 캘린더 (홈 오른쪽)
function miniCalendar(ym, marks) {
  const first = `${ym}-01`;
  const start = D.add(first, -D.wd(first));
  const t = today();
  let cells = WD.map((w, i) => `<div class="wd ${i === 0 ? 'sun' : ''}">${w}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = D.add(start, i);
    if (i >= 35 && D.month(d) !== ym) break;
    const cls = ['day', D.month(d) !== ym && 'out', d === t && 'today', marks.has(d) && 'has', D.wd(d) === 0 && 'sun'].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-action="goto-date" data-date="${d}">${Number(d.slice(8))}</div>`;
  }
  const [y, m] = ym.split('-').map(Number);
  return `<div class="mini-cal">
    <div class="cal-nav"><button class="icon-btn" data-action="mini-month" data-ym="${D.addMonth(ym, -1)}">‹</button>
      <strong>${y}년 ${m}월</strong>
      <button class="icon-btn" data-action="mini-month" data-ym="${D.addMonth(ym, 1)}">›</button></div>
    <div class="mini-grid">${cells}</div></div>`;
}

// ===================== 화면들 =====================
const views = {};
let homeMiniMonth = null;

views.home = async () => {
  const h = await api('GET', '/api/home');
  const ym = homeMiniMonth || D.month(h.today);
  const cal = await api('GET', `/api/calendar?month=${ym}`);
  const marks = new Set([...cal.events.map((e) => e.date), ...cal.todos.filter((t) => !t.done).map((t) => t.due_date)]);

  const todayBody = (h.overdue.length || h.todayTodos.length)
    ? `${h.overdue.length ? `<div class="section-label warn">기한 지남 ${h.overdue.length}</div><ul class="todo-list">${h.overdue.map(todoItem).join('')}</ul>` : ''}
       ${h.overdue.length && h.todayTodos.length ? '<div class="section-label">오늘</div>' : ''}
       ${h.todayTodos.length ? `<ul class="todo-list">${h.todayTodos.map(todoItem).join('')}</ul>` : ''}`
    : empty('오늘 마감인 할 일이 없어요.', '+ 오늘 할 일 추가', 'new-todo', `data-date="${h.today}"`);

  return `
  <section class="home">
    <header class="home-head">
      <div><div class="eyebrow">${esc(D.long(h.today))}</div><h1>오늘의 대시보드</h1></div>
      <div class="actions">
        <button class="btn primary" data-action="new-todo" data-date="${h.today}">+ 할 일</button>
        <button class="btn" data-action="new-event" data-date="${h.today}">+ 일정</button>
      </div>
    </header>
    <div class="stats">
      <a class="stat" href="#/todos?f=today"><span class="label">오늘 남은 할 일<span class="arrow">↗</span></span><span class="num">${h.stats.todayRemaining}</span></a>
      <a class="stat" href="#/todos?f=week"><span class="label">이번 주 마감<span class="arrow">↗</span></span><span class="num">${h.stats.weekDue}</span></a>
      <a class="stat" href="#/projects"><span class="label">진행 중인 프로젝트<span class="arrow">↗</span></span><span class="num">${h.stats.activeProjects}</span></a>
    </div>
    <div class="home-grid">
      <section class="card area-today">
        <div class="card-head"><h3>오늘 할 일</h3><a class="link" href="#/todos?f=today">전체 보기</a></div>
        ${todayBody}
        <form class="quick-add" data-form="quick-todo" data-date="${h.today}">
          <input type="text" name="title" placeholder="오늘 할 일을 입력하고 Enter" autocomplete="off">
        </form>
      </section>
      <section class="card area-projects">
        <div class="card-head"><h3>진행 중인 프로젝트</h3><a class="link" href="#/projects">전체 보기</a></div>
        ${h.projects.length ? `<div class="project-list">${h.projects.map((p) => projectCard(p)).join('')}</div>` : empty('진행 중인 프로젝트가 없어요.', '첫 프로젝트 추가', 'new-project')}
      </section>
      <div class="area-side">
        <section class="card">${miniCalendar(ym, marks)}</section>
        <section class="card">
          <div class="card-head"><h3>다가오는 일정</h3><a class="link" href="#/calendar">캘린더</a></div>
          ${h.upcoming.length ? `<ul class="event-list">${h.upcoming.map(eventItem).join('')}</ul>` : empty('등록된 일정이 없어요.', '첫 일정 추가', 'new-event')}
        </section>
      </div>
    </div>
  </section>`;
};

views.projects = async () => {
  const list = await api('GET', '/api/projects');
  return `
  <div class="page-head"><h1>프로젝트</h1><button class="btn primary" data-action="new-project">+ 프로젝트</button></div>
  ${list.length ? `<div class="project-grid">${list.map((p) => projectCard(p, { showGoal: true })).join('')}</div>` : empty('아직 프로젝트가 없어요.', '첫 프로젝트 추가', 'new-project')}`;
};

views.project = async ({ id }) => {
  let p;
  try { p = await api('GET', `/api/projects/${id}`); } catch (e) {
    if (e.status === 404) return `<div class="empty">프로젝트를 찾을 수 없어요. <a class="btn small" href="#/projects">목록으로</a></div>`;
    throw e;
  }
  currentProject = p;
  const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
  const open = p.todos.filter((t) => !t.done);
  const done = p.todos.filter((t) => t.done);
  remember(cache.events, p.events);
  return `
  <div class="detail-head">
    <div><h1>${esc(p.name)}</h1>
      <div class="sub"><span class="tag ${p.status === 'active' ? 'lime' : ''}">${STATUS_KO[p.status]}</span>
        ${p.due_date ? `<span>마감 ${esc(D.long(p.due_date))}</span>` : '<span>마감일 없음</span>'}</div></div>
    <div class="head-actions"><button class="btn" data-action="edit-project" data-id="${p.id}">수정</button>
      <button class="btn ghost-lime" data-action="open-ai">✦ AI에게 다음 작업 묻기</button></div>
  </div>
  <div class="detail-grid">
    <div>
      ${p.next ? `<div class="next-card"><div class="label">다음에 할 작업</div><div class="title">${esc(p.next.title)}</div>
        <div class="meta">${p.next.due_date ? `마감 ${esc(D.rel(p.next.due_date))}` : '마감일 없음'}</div>
        <button class="btn small" data-action="toggle-todo" data-id="${p.next.id}">✓ 완료로 표시</button></div>` : ''}
      <section class="card">
        <div class="card-head"><h3>할 일 <span class="dim" style="font-weight:400">${open.length}개 남음</span></h3></div>
        ${open.length ? `<ul class="todo-list">${open.map(todoItem).join('')}</ul>` : `<div class="empty">${p.total ? '모든 할 일을 끝냈어요.' : '이 프로젝트의 첫 할 일을 추가하세요.'}</div>`}
        <form class="quick-add" data-form="quick-todo" data-project="${p.id}">
          <input type="text" name="title" placeholder="할 일 추가 후 Enter" autocomplete="off">
          <input type="date" name="due_date">
          <button class="btn primary">추가</button>
        </form>
        ${done.length ? `<div class="section-label">완료 ${done.length}</div><ul class="todo-list">${done.map(todoItem).join('')}</ul>` : ''}
      </section>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <section class="card">
        <div class="card-head"><h3>진행률</h3><span class="muted">${p.completed} / ${p.total}</span></div>
        <div class="big-pct">${pct}%</div>
        <div class="progress"><span style="width:${pct}%"></span></div>
      </section>
      <section class="card">
        <div class="card-head"><h3>목표</h3></div>
        <div class="goal-text">${p.goal ? esc(p.goal) : '<span class="dim">목표가 아직 없어요. [수정]에서 입력하세요.</span>'}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>예정된 일정</h3><button class="btn small" data-action="new-event" data-project="${p.id}">+ 일정</button></div>
        ${p.events.length ? `<ul class="event-list">${p.events.map(eventItem).join('')}</ul>` : '<div class="dim">이 프로젝트에 연결된 일정이 없어요.</div>'}
      </section>
    </div>
  </div>`;
};

const TODO_FILTERS = [['today', '오늘'], ['week', '이번 주'], ['upcoming', '예정'], ['done', '완료']];
views.todos = async ({ query }) => {
  const f = TODO_FILTERS.some(([k]) => k === query.get('f')) ? query.get('f') : 'today';
  const rows = await api('GET', `/api/todos?filter=${f}`);
  let body;
  if (!rows.length) {
    body = f === 'done' ? '<div class="empty">완료한 할 일이 아직 없어요.</div>'
      : empty(f === 'today' ? '오늘 할 일이 없어요.' : '예정된 할 일이 없어요.', '+ 할 일 추가', 'new-todo', f === 'today' ? `data-date="${today()}"` : '');
  } else if (f === 'done') {
    body = `<ul class="todo-list">${rows.map(todoItem).join('')}</ul>`;
  } else {
    // 날짜별로 묶어서 표시
    const groups = new Map();
    for (const t of rows) {
      const key = !t.due_date ? '날짜 없음' : t.due_date < today() ? '기한 지남' : `${D.rel(t.due_date)}${D.rel(t.due_date).includes('/') ? '' : ' · ' + D.short(t.due_date)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    body = [...groups].map(([k, list]) => `<div class="group-date ${k === '기한 지남' ? 'section-label warn' : ''}">${esc(k)}</div><ul class="todo-list">${list.map(todoItem).join('')}</ul>`).join('');
  }
  const defDate = f === 'today' ? today() : f === 'upcoming' ? D.add(today(), 1) : '';
  return `
  <div class="page-head"><h1>할 일</h1><button class="btn primary" data-action="new-todo" ${defDate ? `data-date="${defDate}"` : ''}>+ 할 일</button></div>
  <div class="chips" style="margin-bottom:16px">${TODO_FILTERS.map(([k, l]) => `<a class="chip ${k === f ? 'active' : ''}" href="#/todos?f=${k}">${l}</a>`).join('')}</div>
  <section class="card">
    ${f !== 'done' ? `<form class="quick-add" data-form="quick-todo" style="margin:0 0 16px">
      <input type="text" name="title" placeholder="새 할 일 입력 후 Enter" autocomplete="off">
      <input type="date" name="due_date" value="${defDate}">
      <button class="btn primary">추가</button></form>` : ''}
    ${body}
  </section>`;
};

views.calendar = async ({ query }) => {
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(query.get('d') || '') ? query.get('d') : today();
  const ym = /^\d{4}-\d{2}$/.test(query.get('m') || '') ? query.get('m') : D.month(sel);
  const cal = await api('GET', `/api/calendar?month=${ym}`);
  remember(cache.events, cal.events);
  remember(cache.todos, cal.todos);
  const byDate = new Map();
  const push = (d, item) => { if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(item); };
  cal.events.forEach((e) => push(e.date, { type: 'ev', e }));
  cal.todos.forEach((t) => push(t.due_date, { type: 'td', t }));

  const first = `${ym}-01`;
  const start = D.add(first, -D.wd(first));
  const t = today();
  let cells = WD.map((w, i) => `<div class="wd ${i === 0 ? 'sun' : ''}">${w}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = D.add(start, i);
    if (i >= 35 && D.month(d) !== ym) break;
    const items = byDate.get(d) || [];
    const pills = items.slice(0, 3).map((it) => it.type === 'ev'
      ? `<div class="pill ev">${it.e.start_time ? esc(it.e.start_time) + ' ' : ''}${esc(it.e.title)}</div>`
      : `<div class="pill td ${it.t.done ? 'done' : ''}">☐ ${esc(it.t.title)}</div>`).join('');
    const cls = ['cell', D.month(d) !== ym && 'out', d === t && 'today', d === sel && 'selected', D.wd(d) === 0 && 'sun', items.length && 'has-items'].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-action="select-date" data-date="${d}"><span class="num">${Number(d.slice(8))}</span>${pills}${items.length > 3 ? `<div class="pill more">+${items.length - 3}</div>` : ''}</div>`;
  }

  // 선택한 날짜의 목록 (다른 달의 날짜를 골랐을 수도 있어 따로 조회)
  let dayEvents, dayTodos;
  if (D.month(sel) === ym) {
    dayEvents = cal.events.filter((e) => e.date === sel);
    dayTodos = cal.todos.filter((x) => x.due_date === sel);
  } else {
    [dayEvents, dayTodos] = await Promise.all([api('GET', `/api/events?from=${sel}&to=${sel}`), api('GET', `/api/todos?date=${sel}`)]);
  }
  const [y, m] = ym.split('-').map(Number);
  return `
  <div class="cal-toolbar">
    <button class="icon-btn" data-action="cal-month" data-ym="${D.addMonth(ym, -1)}" aria-label="이전 달">‹</button>
    <h1>${y}년 ${m}월</h1>
    <button class="icon-btn" data-action="cal-month" data-ym="${D.addMonth(ym, 1)}" aria-label="다음 달">›</button>
    <button class="btn small" data-action="select-date" data-date="${t}">오늘</button>
    <span class="spacer"></span>
    <button class="btn primary" data-action="new-event" data-date="${sel}">+ 일정</button>
  </div>
  <div class="cal-layout">
    <section class="card"><div class="month-grid">${cells}</div></section>
    <section class="card">
      <div class="card-head"><h3>${esc(D.long(sel))}</h3></div>
      <div class="section-label">일정</div>
      ${dayEvents.length ? `<ul class="event-list">${dayEvents.map(eventItem).join('')}</ul>` : empty('이날 일정이 없어요.', '+ 일정 추가', 'new-event', `data-date="${sel}"`)}
      <div class="section-label">마감 할 일</div>
      ${dayTodos.length ? `<ul class="todo-list">${dayTodos.map(todoItem).join('')}</ul>` : ''}
      <form class="quick-add" data-form="quick-todo" data-date="${sel}">
        <input type="text" name="title" placeholder="이날 마감 할 일 추가" autocomplete="off">
        <button class="btn primary">추가</button>
      </form>
    </section>
  </div>`;
};

views.settings = async () => {
  settings = await api('GET', '/api/settings');
  const a = settings.ai;
  return `
  <div class="page-head"><h1>설정</h1></div>
  <div class="settings">
    <section class="card">
      <div class="card-head"><h3>OpenAI API 연결</h3></div>
      <div class="kv">
        <span class="k">API 키</span><span><span class="status-dot ${a.keyConfigured ? 'ok' : 'bad'}"></span>${a.keyConfigured ? '설정됨 (서버 환경변수)' : '설정되지 않음'}</span>
        <span class="k">모델</span><span><code>${esc(a.model)}</code></span>
        <span class="k">연결 상태</span><span id="conn-result" class="muted">아직 확인하지 않음</span>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn primary" data-action="test-api">연결 테스트</button>
        ${a.keyConfigured ? '' : '<span class="muted" style="font-size:13px">프로젝트 폴더의 <code>.env</code> 파일에 <code>OPENAI_API_KEY=...</code> 를 넣고 서버를 다시 실행하세요.</span>'}
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h3>시간대</h3></div>
      <div class="kv">
        <span class="k">기준 시간대</span><span><code>${esc(settings.timezone)}</code></span>
        <span class="k">오늘 날짜</span><span>${esc(D.long(settings.today))}</span>
      </div>
      <p class="muted" style="font-size:13px;margin:14px 0 0">'오늘', '이번 주', 지연 여부는 모두 이 시간대 기준으로 계산합니다. 변경하려면 <code>.env</code> 에 <code>APP_TIMEZONE</code> 을 지정하세요.</p>
    </section>
    <section class="card">
      <div class="card-head"><h3>데이터</h3></div>
      <div class="kv"><span class="k">DB 파일</span><span><code style="overflow-wrap:anywhere">${esc(settings.dbPath)}</code></span></div>
      <p class="muted" style="font-size:13px;margin:14px 0 0">이 파일 하나만 복사해 두면 백업이 됩니다.</p>
    </section>
    <section class="card">
      <div class="card-head"><h3>서버</h3></div>
      <p class="muted" style="font-size:13px;margin:0 0 14px">바탕화면 아이콘이나 자동 실행으로 켠 서버는 창 없이 동작합니다. 여기서 끌 수 있고, 아이콘을 다시 누르면 켜집니다.</p>
      <button class="btn danger" data-action="shutdown">서버 종료</button>
    </section>
  </div>`;
};

views.chat = async ({ query }) => {
  const c = query.get('c');
  if (c && Number(c) !== chat.conversationId) await chat.load(Number(c));
  return `<div class="chat-page">
    <section class="card conv-panel" style="display:flex;flex-direction:column;gap:10px;min-height:0">
      <button class="btn primary" data-action="chat-new">+ 새 대화</button>
      <div class="conv-list" id="conv-list"></div>
    </section>
    <section class="card chat-card" id="page-chat"></section>
  </div>`;
};

// ===================== 라우터 =====================
let currentRoute = { name: 'home' };
let currentProject = null;
const TITLES = { home: '홈', projects: '프로젝트', project: '프로젝트', todos: '할 일', calendar: '일정', chat: 'AI 채팅', settings: '설정' };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  const parts = p.split('/').filter(Boolean);
  const query = new URLSearchParams(q);
  if (parts[0] === 'projects' && parts[1]) return { name: 'project', id: Number(parts[1]), query };
  const name = views[parts[0]] ? parts[0] : 'home';
  return { name, query };
}

let renderSeq = 0;
async function render() {
  const r = parseHash();
  const seq = ++renderSeq;
  if (r.name !== 'project') currentProject = null;
  currentRoute = r;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (r.name === 'project' ? 'projects' : r.name)));
  $('#page-title').textContent = TITLES[r.name];
  $('#open-ai').classList.toggle('hidden', r.name === 'chat');
  if (r.name === 'chat') closeDrawer();
  try {
    const html = await views[r.name](r);
    if (seq !== renderSeq) return; // 그 사이 다른 화면으로 이동함
    const view = $('#view');
    // 입력 중이던 빠른 추가 칸 내용 보존
    const draft = view.querySelector('form[data-form=quick-todo] input[name=title]');
    const draftVal = draft && document.activeElement === draft ? draft.value : null;
    view.innerHTML = html;
    if (draftVal !== null) { const n = view.querySelector('form[data-form=quick-todo] input[name=title]'); if (n) { n.value = draftVal; n.focus(); } }
    if (r.name === 'chat') { chat.mount($('#page-chat'), 'page'); renderConvList(); }
  } catch (e) {
    if (seq !== renderSeq) return;
    $('#view').innerHTML = `<div class="empty">불러오지 못했어요: ${esc(e.message)}<button class="btn small" data-action="reload">다시 시도</button></div>`;
  }
}
// 데이터가 바뀐 뒤 현재 화면을 새로 그린다
const refresh = () => render();

window.addEventListener('hashchange', render);

// ===================== 모달 (추가/수정) =====================
let projectOptionsCache = null;
async function projectOptions(selected) {
  projectOptionsCache = await api('GET', '/api/projects');
  return `<option value="">(개인 / 프로젝트 없음)</option>` + projectOptionsCache.map((p) =>
    `<option value="${p.id}" ${Number(selected) === p.id ? 'selected' : ''}>${esc(p.name)}${p.status !== 'active' ? ` (${STATUS_KO[p.status]})` : ''}</option>`).join('');
}

function openModal(html, onSubmit, onDelete) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><form class="modal" novalidate>${html}
    <div class="form-error"></div>
    <div class="foot">${onDelete ? '<button type="button" class="btn danger left" data-m="delete">삭제</button>' : ''}
      <button type="button" class="btn" data-m="cancel">취소</button><button class="btn primary" data-m="save">저장</button></div>
  </form></div>`;
  const form = $('form', root);
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.modal-backdrop', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
  $('[data-m=cancel]', root).onclick = close;
  let busy = false;
  const guard = (fn) => async () => {
    if (busy) return;
    busy = true;
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try { await fn(); close(); refresh(); } catch (e) { $('.form-error', root).textContent = e.message; } finally { busy = false; form.querySelectorAll('button').forEach((b) => (b.disabled = false)); }
  };
  if (onDelete) $('[data-m=delete]', root).onclick = () => { if (confirmDelete(form)) guard(onDelete)(); };
  form.onsubmit = (e) => { e.preventDefault(); guard(() => onSubmit(Object.fromEntries(new FormData(form))))(); };
  const first = form.querySelector('input[type=text]');
  if (first) first.focus();
}
// 브라우저 기본 confirm 대신 버튼을 두 번 누르게 한다
function confirmDelete(form) {
  const b = $('[data-m=delete]', form);
  if (b.dataset.armed) return true;
  b.dataset.armed = '1';
  b.textContent = '한 번 더 누르면 삭제';
  return false;
}

async function todoModal({ todo, date, projectId } = {}) {
  const t = todo || { title: '', due_date: date || '', project_id: projectId || '', memo: '' };
  openModal(`<h3>${todo ? '할 일 수정' : '할 일 추가'}</h3>
    <label class="field">할 일<input type="text" name="title" value="${esc(t.title)}" required maxlength="300"></label>
    <div class="row"><label class="field">마감일<input type="date" name="due_date" value="${esc(t.due_date || '')}"></label>
      <label class="field">프로젝트<select name="project_id">${await projectOptions(t.project_id)}</select></label></div>
    <label class="field">메모<textarea name="memo" maxlength="2000">${esc(t.memo || '')}</textarea></label>`,
  async (v) => {
    const body = { title: v.title, due_date: v.due_date || null, project_id: v.project_id || null, memo: v.memo };
    if (todo) await api('PUT', `/api/todos/${todo.id}`, body); else await api('POST', '/api/todos', body);
    toast(todo ? '수정했어요' : '할 일을 추가했어요');
  },
  todo ? async () => { await api('DELETE', `/api/todos/${todo.id}`); toast('삭제했어요'); } : null);
}

async function eventModal({ event, date, projectId } = {}) {
  const e = event || { title: '', date: date || today(), start_time: '', end_time: '', project_id: projectId || '', memo: '' };
  openModal(`<h3>${event ? '일정 수정' : '일정 추가'}</h3>
    <label class="field">제목<input type="text" name="title" value="${esc(e.title)}" required maxlength="300"></label>
    <label class="field">날짜<input type="date" name="date" value="${esc(e.date)}" required></label>
    <div class="row"><label class="field">시작 (비우면 종일)<input type="time" name="start_time" value="${esc(e.start_time || '')}"></label>
      <label class="field">종료<input type="time" name="end_time" value="${esc(e.end_time || '')}"></label></div>
    <label class="field">프로젝트<select name="project_id">${await projectOptions(e.project_id)}</select></label>
    <label class="field">메모<textarea name="memo" maxlength="2000">${esc(e.memo || '')}</textarea></label>`,
  async (v) => {
    const body = { title: v.title, date: v.date, start_time: v.start_time || null, end_time: v.end_time || null, project_id: v.project_id || null, memo: v.memo };
    if (event) await api('PUT', `/api/events/${event.id}`, body); else await api('POST', '/api/events', body);
    toast(event ? '수정했어요' : '일정을 추가했어요');
  },
  event ? async () => { await api('DELETE', `/api/events/${event.id}`); toast('삭제했어요'); } : null);
}

function projectModal(project) {
  const p = project || { name: '', goal: '', due_date: '', status: 'active' };
  openModal(`<h3>${project ? '프로젝트 수정' : '프로젝트 추가'}</h3>
    <label class="field">프로젝트명<input type="text" name="name" value="${esc(p.name)}" required maxlength="120"></label>
    <label class="field">목표<textarea name="goal" maxlength="2000" placeholder="이 프로젝트로 이루려는 것 (AI가 다음 작업을 제안할 때 참고합니다)">${esc(p.goal)}</textarea></label>
    <div class="row"><label class="field">마감일<input type="date" name="due_date" value="${esc(p.due_date || '')}"></label>
      <label class="field">상태<select name="status">${Object.entries(STATUS_KO).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>`,
  async (v) => {
    const body = { name: v.name, goal: v.goal, due_date: v.due_date || null, status: v.status };
    if (project) await api('PUT', `/api/projects/${project.id}`, body);
    else { const created = await api('POST', '/api/projects', body); location.hash = `#/projects/${created.id}`; }
    projectOptionsCache = null; // 채팅의 프로젝트 목록도 새로 받도록
    toast(project ? '수정했어요' : '프로젝트를 만들었어요');
  },
  project ? async () => { await api('DELETE', `/api/projects/${project.id}`); projectOptionsCache = null; toast('삭제했어요 (할 일은 개인 할 일로 남습니다)'); location.hash = '#/projects'; } : null);
}

// ===================== AI 채팅 =====================
const chat = {
  conversationId: null,
  conversation: null,
  scope: { type: 'today', projectId: null },
  draft: '',
  sending: false,
  error: null,
  applying: new Set(),
  el: null,
  mode: null,
  viewSeq: 0, // 보고 있는 대화가 바뀔 때마다 증가 (늦게 도착한 응답이 다른 대화를 덮어쓰지 않도록)

  async load(id) {
    const seq = ++this.viewSeq;
    const conv = await api('GET', `/api/conversations/${id}`);
    if (seq !== this.viewSeq) return;
    this.conversation = conv;
    this.conversationId = id;
    this.error = null;
  },
  reset() { this.viewSeq++; this.conversation = null; this.conversationId = null; this.error = null; },

  mount(el, mode) { this.el = el; this.mode = mode; this.render(); },

  scopeLabel() {
    if (this.scope.type === 'project') {
      const p = (projectOptionsCache || []).find((x) => x.id === Number(this.scope.projectId));
      return p ? `프로젝트: ${p.name}` : '프로젝트';
    }
    return this.scope.type === 'all' ? '전체 데이터' : '오늘 할 일';
  },

  async render() {
    if (!this.el) return;
    if (!projectOptionsCache) { try { projectOptionsCache = await api('GET', '/api/projects'); } catch { projectOptionsCache = []; } }
    const prevInput = this.el.querySelector('textarea');
    const hadFocus = prevInput && document.activeElement === prevInput;
    const msgs = this.conversation ? this.conversation.messages : [];
    const projects = projectOptionsCache.filter((p) => p.status !== 'done' || Number(this.scope.projectId) === p.id);
    const s = this.scope;

    const convBar = this.mode === 'drawer' ? `<div class="conv-bar">
      <select data-chat="pick-conv"><option value="">새 대화</option>${(this.convs || []).map((c) => `<option value="${c.id}" ${c.id === this.conversationId ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}</select>
      <button class="btn small" data-action="chat-new">+ 새 대화</button></div>` : '';

    const suggestions = [
      '오늘 뭐부터 할까?',
      s.type === 'project' ? '이 프로젝트 다음에 뭘 해야 해?' : null,
      '내일 오후 3시에 프로젝트 회의 등록해줘.',
    ].filter(Boolean);

    this.el.innerHTML = `<div class="chat">
      ${convBar}
      <div class="scope-bar"><span class="lbl">참고 범위</span>
        <button class="chip ${s.type === 'today' ? 'active' : ''}" data-chat="scope" data-type="today">오늘 할 일</button>
        <button class="chip ${s.type === 'project' ? 'active' : ''}" data-chat="scope" data-type="project" ${projects.length ? '' : 'disabled title="프로젝트가 없어요"'}>현재 프로젝트</button>
        ${s.type === 'project' ? `<select data-chat="scope-project">${projects.map((p) => `<option value="${p.id}" ${Number(s.projectId) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
        <button class="chip ${s.type === 'all' ? 'active' : ''}" data-chat="scope" data-type="all">전체</button>
      </div>
      <div class="messages">
        ${msgs.length ? msgs.map((m) => this.msgHtml(m)).join('') : `<div class="suggestions"><div class="hint">GPT가 위 범위의 할 일·일정을 보고 답합니다. 이렇게 물어보세요:</div>${suggestions.map((q) => `<button class="suggestion" data-chat="suggest">${esc(q)}</button>`).join('')}</div>`}
        ${this.sending ? '<div class="msg assistant typing">생각하는 중…</div>' : ''}
      </div>
      ${this.error ? `<div class="chat-error"><span>${esc(this.error)}</span><button class="btn small" data-chat="retry">재시도</button></div>` : ''}
      <form class="composer" data-chat="form">
        <textarea rows="1" placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)" ${this.sending ? 'disabled' : ''}>${esc(this.draft)}</textarea>
        <button class="btn primary" ${this.sending ? 'disabled' : ''}>전송</button>
      </form>
    </div>`;
    const box = this.el.querySelector('.messages');
    box.scrollTop = box.scrollHeight;
    const ta = this.el.querySelector('textarea');
    if (hadFocus || (!this.sending && this.error)) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  },

  msgHtml(m) {
    const text = esc(m.content).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const note = m.role === 'user' && m.scope_label ? `<span class="scope-note">${esc(m.scope_label)}</span>` : '';
    return `<div class="msg ${m.role}">${note}${text}</div>` + (m.proposals || []).map((p) => this.proposalHtml(p)).join('');
  },

  proposalHtml(p) {
    const v = p.payload;
    const rows = p.kind === 'event'
      ? [['제목', v.title], ['날짜', D.long(v.date)], ['시간', v.start_time ? (v.end_time ? `${v.start_time} ~ ${v.end_time}` : v.start_time) : '종일'], v.project_name && ['프로젝트', v.project_name]]
      : [['할 일', v.title], ['마감일', v.due_date ? D.long(v.due_date) : '없음'], v.project_name && ['프로젝트', v.project_name]];
    const busy = this.applying.has(p.id);
    let actions;
    if (p.status === 'applied') {
      const link = p.kind === 'event' ? `#/calendar?d=${v.date}` : v.due_date ? `#/calendar?d=${v.due_date}` : '#/todos?f=upcoming';
      actions = `<span class="tag lime">✓ 등록됨</span><a class="btn small" href="${link}">${p.kind === 'event' ? '캘린더에서 보기' : '확인하기'}</a>`;
    } else if (p.status === 'dismissed') {
      actions = '<span class="tag">취소됨</span>';
    } else {
      actions = `<button class="btn primary small" data-chat="apply" data-id="${p.id}" ${busy ? 'disabled' : ''}>${busy ? '등록 중…' : '등록'}</button>
        <button class="btn small" data-chat="dismiss" data-id="${p.id}" ${busy ? 'disabled' : ''}>취소</button>`;
    }
    return `<div class="proposal ${p.status}"><div class="kind">${p.kind === 'event' ? '일정 등록 미리보기' : '할 일 추가 미리보기'}</div>
      <div class="kv">${rows.filter(Boolean).map(([k, val]) => `<span class="k">${k}</span><span>${esc(val)}</span>`).join('')}</div>
      <div class="actions">${actions}</div></div>`;
  },

  async send(text) {
    text = (text ?? this.draft).trim();
    if (!text || this.sending) return;
    this.draft = text;
    this.sending = true;
    this.error = null;
    this.render();
    const seq = this.viewSeq;
    try {
      const conv = await api('POST', '/api/chat', {
        conversationId: this.conversationId,
        message: text,
        scope: { type: this.scope.type, projectId: this.scope.projectId },
      });
      if (seq !== this.viewSeq) { await refreshConvs(); return; } // 그 사이 다른 대화로 이동함
      const isNew = !this.conversationId;
      this.conversation = conv;
      this.conversationId = conv.id;
      this.draft = '';
      if (isNew && currentRoute.name === 'chat') history.replaceState(null, '', `#/chat?c=${conv.id}`);
      await refreshConvs();
    } catch (e) {
      // 실패해도 입력한 메시지는 입력창에 그대로 남긴다
      if (seq === this.viewSeq) this.error = e.message;
    } finally {
      this.sending = false;
      this.render();
    }
  },

  async apply(id) {
    if (this.applying.has(id)) return; // 연달아 눌러도 요청은 한 번
    this.applying.add(id);
    this.render();
    try {
      const r = await api('POST', `/api/proposals/${id}/apply`);
      toast(r.already ? '이미 등록된 항목이에요' : '등록했어요');
      await this.load(this.conversationId);
      refresh(); // 홈/캘린더 등 열려 있는 화면에 바로 반영
    } catch (e) {
      toast(`등록 실패: ${e.message}`);
    } finally {
      this.applying.delete(id);
      this.render();
    }
  },

  async dismiss(id) {
    try { await api('POST', `/api/proposals/${id}/dismiss`); await this.load(this.conversationId); } catch (e) { toast(e.message); }
    this.render();
  },
};

async function refreshConvs() {
  try { chat.convs = await api('GET', '/api/conversations'); } catch { chat.convs = []; }
  renderConvList();
}
function renderConvList() {
  const el = $('#conv-list');
  if (!el) return;
  const list = chat.convs || [];
  el.innerHTML = list.length ? list.map((c) => `<div class="conv-item ${c.id === chat.conversationId ? 'active' : ''}" data-chat="open-conv" data-id="${c.id}">
      <span class="t">${esc(c.title)}</span><button class="del" data-chat="del-conv" data-id="${c.id}" title="삭제">✕</button></div>`).join('')
    : '<div class="dim" style="font-size:14px;padding:4px 6px">이전 대화가 없어요.</div>';
}

// 채팅 영역 이벤트 (페이지/드로어 공용)
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-chat]');
  if (!el) return;
  const act = el.dataset.chat;
  if (act === 'scope') {
    chat.scope.type = el.dataset.type;
    if (chat.scope.type === 'project' && !chat.scope.projectId) {
      const p = currentProject || (projectOptionsCache || []).find((x) => x.status === 'active') || (projectOptionsCache || [])[0];
      chat.scope.projectId = p ? p.id : null;
    }
    chat.render();
  } else if (act === 'suggest') {
    chat.send(el.textContent);
  } else if (act === 'retry') {
    chat.send(chat.el.querySelector('textarea').value);
  } else if (act === 'apply') {
    chat.apply(Number(el.dataset.id));
  } else if (act === 'dismiss') {
    chat.dismiss(Number(el.dataset.id));
  } else if (act === 'del-conv') {
    e.stopPropagation();
    if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = '삭제?'; el.style.visibility = 'visible'; return; }
    await api('DELETE', `/api/conversations/${el.dataset.id}`);
    if (Number(el.dataset.id) === chat.conversationId) { chat.reset(); if (currentRoute.name === 'chat') history.replaceState(null, '', '#/chat'); }
    await refreshConvs();
    chat.render();
  } else if (act === 'open-conv') {
    location.hash = `#/chat?c=${el.dataset.id}`;
    await chat.load(Number(el.dataset.id));
    renderConvList();
    chat.render();
  }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-chat]');
  if (!el) return;
  if (el.dataset.chat === 'scope-project') { chat.scope.projectId = Number(el.value); chat.render(); }
  if (el.dataset.chat === 'pick-conv') {
    if (el.value) await chat.load(Number(el.value)); else chat.reset();
    chat.render();
  }
});
document.addEventListener('submit', (e) => {
  if (e.target.matches('[data-chat=form]')) { e.preventDefault(); chat.send(e.target.querySelector('textarea').value); }
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('.composer textarea') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    chat.send(e.target.value);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.matches('.composer textarea')) {
    chat.draft = e.target.value;
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  }
});

// 드로어 (다른 화면에서 'AI 열기')
function openDrawer() {
  // 프로젝트 화면에서 열면 현재 프로젝트를 기본 범위로
  if (currentProject) chat.scope = { type: 'project', projectId: currentProject.id };
  else if (chat.scope.type === 'project' && currentRoute.name === 'home') chat.scope = { type: 'today', projectId: null };
  projectOptionsCache = null; // 최신 프로젝트 목록으로
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  refreshConvs().then(() => chat.mount($('#drawer-chat'), 'drawer'));
  chat.mount($('#drawer-chat'), 'drawer');
  setTimeout(() => { const ta = $('#drawer-chat textarea'); if (ta) ta.focus(); }, 230);
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

// ===================== 화면 공통 동작 =====================
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, date, project, ym } = el.dataset;
  switch (action) {
    case 'toggle-todo': {
      e.preventDefault();
      if (el.disabled) return;
      el.disabled = true;
      const t = cache.todos.get(Number(id));
      const done = t ? !t.done : true;
      try { await api('PUT', `/api/todos/${id}`, { done }); if (done) toast('완료! 👏'); } catch (err) { toast(err.message); }
      refresh();
      break;
    }
    case 'edit-todo': todoModal({ todo: cache.todos.get(Number(id)) }); break;
    case 'new-todo': todoModal({ date, projectId: project || (currentProject && currentProject.id) }); break;
    case 'edit-event': eventModal({ event: cache.events.get(Number(id)) }); break;
    case 'new-event': eventModal({ date, projectId: project }); break;
    case 'new-project': projectModal(); break;
    case 'edit-project': projectModal(currentProject); break;
    case 'goto-date': location.hash = `#/calendar?d=${date}`; break;
    case 'select-date': location.hash = `#/calendar?d=${date}`; break;
    case 'cal-month': location.hash = `#/calendar?m=${ym}&d=${currentRoute.query.get('d') || today()}`; break;
    case 'mini-month': homeMiniMonth = ym; refresh(); break;
    case 'open-ai': openDrawer(); break;
    case 'close-ai': closeDrawer(); break;
    case 'chat-new':
      chat.reset();
      if (currentRoute.name === 'chat') { history.replaceState(null, '', '#/chat'); renderConvList(); }
      chat.render();
      break;
    case 'test-api': {
      const out = $('#conn-result');
      out.textContent = '확인 중…';
      el.disabled = true;
      try {
        const r = await api('POST', '/api/settings/test');
        out.innerHTML = `<span class="status-dot ${r.ok ? 'ok' : 'bad'}"></span>${esc(r.message)}`;
      } catch (err) { out.textContent = err.message; }
      el.disabled = false;
      break;
    }
    case 'reload': refresh(); break;
    case 'shutdown': {
      if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = '한 번 더 누르면 종료'; return; }
      try { await api('POST', '/api/shutdown'); } catch { /* 이미 꺼짐 */ }
      document.body.innerHTML = '<div class="empty" style="margin:20vh auto;max-width:420px">서버를 종료했습니다. 다시 쓰려면 바탕화면의 <b>My Dashboard</b> 아이콘을 누르거나 <code>npm start</code> 로 실행하세요.</div>';
      break;
    }
  }
});

// 빠른 할 일 추가 (Enter)
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('[data-form=quick-todo]')) return;
  e.preventDefault();
  const input = f.querySelector('input[name=title]');
  const title = input.value.trim();
  if (!title || f.dataset.busy) return;
  f.dataset.busy = '1';
  const dateInput = f.querySelector('input[name=due_date]');
  try {
    await api('POST', '/api/todos', {
      title,
      due_date: dateInput ? dateInput.value || null : f.dataset.date || null,
      project_id: f.dataset.project || null,
    });
    input.value = '';
    toast('할 일을 추가했어요');
    await refresh();
    const again = $('#view form[data-form=quick-todo] input[name=title]');
    if (again) again.focus();
  } catch (err) { toast(err.message); } finally { delete f.dataset.busy; }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#drawer').classList.contains('open') && !$('#modal-root').children.length) closeDrawer();
});

// ===================== 시작 =====================
(async () => {
  try { settings = await api('GET', '/api/settings'); } catch { /* 기본값 사용 */ }
  if (!location.hash) history.replaceState(null, '', '#/home');
  render();
  refreshConvs();
})();
