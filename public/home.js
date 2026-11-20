// 홈 화면: 인사말 · 통계 3개 · 오늘 일정 타임라인 · 확인 필요 · 현재 집중(타이머) · 다음 할 일 · 오늘 할 일 · 습관
// app.js 다음에 로드된다 (app.js 의 api, esc, views, 모달 함수들을 그대로 사용).
'use strict';

const HOUR_PX = 60; // 타임라인 1시간 높이
const BLOCK_COLORS = ['#8b7cf6', '#d16bd6', '#22d8ee', '#f5a524', '#4ade80', '#f47272'];
const blockColor = (e) => (e.project_id ? BLOCK_COLORS[e.project_id % BLOCK_COLORS.length] : '#5b6170');
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const pad2 = (n) => String(n).padStart(2, '0');
const minToHHMM = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;

function fmtMin(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}
function greeting(hour) {
  if (hour < 5) return '늦은 밤이에요';
  if (hour < 12) return '좋은 아침이에요';
  if (hour < 18) return '좋은 오후예요';
  return '좋은 저녁이에요';
}
function elapsed(startedAt) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

let homeData = null;

// ---------- 타임라인 ----------
function blockEndMin(e) { return e.end_time ? toMin(e.end_time) : toMin(e.start_time) + 60; }

// 겹치는 블록을 나란히 놓기 위해 열(lane)을 나눈다
function layoutBlocks(blocks) {
  const items = blocks.map((e) => ({ e, s: toMin(e.start_time), t: Math.max(blockEndMin(e), toMin(e.start_time) + 15) }))
    .sort((a, b) => a.s - b.s || b.t - a.t);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of cluster) {
      let i = lanes.findIndex((end) => end <= it.s);
      if (i < 0) { i = lanes.length; lanes.push(0); }
      lanes[i] = it.t;
      it.lane = i;
    }
    cluster.forEach((it) => (it.lanes = lanes.length));
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.t);
  }
  if (cluster.length) flush();
  return items;
}

function timeline(d) {
  const nowMin = toMin(d.now);
  const starts = d.blocks.map((e) => toMin(e.start_time));
  const ends = d.blocks.map(blockEndMin);
  const from = Math.max(0, Math.min(8, Math.floor(Math.min(nowMin, ...starts) / 60)));
  const to = Math.min(24, Math.max(20, Math.ceil(Math.max(nowMin + 1, ...ends) / 60)));
  const hours = [];
  for (let h = from; h <= to; h++) hours.push(h);
  const y = (m) => ((m - from * 60) / 60) * HOUR_PX;
  const running = d.running && d.running.event_id;

  const blocks = layoutBlocks(d.blocks).map(({ e, s, t, lane, lanes }) => {
    cache.events.set(e.id, e);
    const h = Math.max(30, y(t) - y(s) - 4);
    const compact = h < 46;
    const isRunning = running === e.id;
    return `<div class="tl-block ${e.done ? 'done' : ''} ${isRunning ? 'running' : ''} ${compact ? 'compact' : ''}"
        style="top:${y(s) + 2}px;height:${h}px;left:calc(${(lane / lanes) * 100}% + 4px);width:calc(${100 / lanes}% - 8px);--c:${blockColor(e)}"
        data-action="edit-event" data-id="${e.id}">
      <button class="tl-check" data-action="toggle-block" data-id="${e.id}" aria-label="${e.done ? '완료 취소' : '완료'}">${e.done ? '✓' : ''}</button>
      <div class="tl-text"><div class="tl-title">${esc(e.title)}</div>
        <div class="tl-meta">${esc(e.start_time)}–${esc(minToHHMM(t))} · ${fmtMin(e.minutes)}${e.project_name ? ' · ' + esc(e.project_name) : ''}</div></div>
      ${e.done ? '' : `<button class="tl-play" data-action="${isRunning ? 'timer-stop' : 'timer-start'}" data-id="${e.id}" title="${isRunning ? '타이머 정지' : '타이머 시작'}">${isRunning ? '■' : '▶'}</button>`}
    </div>`;
  }).join('');

  const allDay = d.allDay.map((e) => { cache.events.set(e.id, e); return `<span class="tl-allday" data-action="edit-event" data-id="${e.id}">${esc(e.title)}</span>`; }).join('');
  return `<div class="tl" data-keep-scroll="timeline">
    <div class="tl-row-any"><span class="tl-hour">종일</span><div class="tl-any-items">${allDay || '<span class="dim">—</span>'}</div></div>
    <div class="tl-body" style="height:${(to - from) * HOUR_PX}px" data-from="${from}">
      ${hours.map((h) => `<div class="tl-line" style="top:${y(h * 60)}px"><span class="tl-hour">${pad2(h)}:00</span></div>`).join('')}
      <div class="tl-lane" data-action="tl-empty">${blocks}
        <div class="tl-now" style="top:${y(nowMin)}px"><span>${esc(d.now)}</span></div>
      </div>
    </div>
  </div>`;
}

// ---------- 홈 ----------
views.home = async () => {
  const d = await api('GET', '/api/today');
  homeData = d;
  const st = d.dayStats;
  const pct = st.blocksTotal ? Math.round((st.blocksDone / st.blocksTotal) * 100) : 0;
  const left = Math.max(0, st.plannedMin - st.completedMin);

  // 확인 필요
  const attention = [];
  if (d.slipped.length) {
    attention.push(`<div class="attn">
      <div class="attn-icon">⏱</div>
      <div class="attn-body"><div class="attn-title">블록 ${d.slipped.length}개가 체크 없이 지났어요</div>
        <div class="attn-text">시간이 지났는데 완료 표시가 없어요. 완료로 표시하거나 다른 날로 옮기세요.</div></div>
      <button class="attn-fix" data-action="fix-slipped">정리</button></div>`);
  }
  if (d.overdue.length) {
    attention.push(`<div class="attn">
      <div class="attn-icon">!</div>
      <div class="attn-body"><div class="attn-title">기한 지난 할 일 ${d.overdue.length}개</div>
        <div class="attn-text">${d.overdue.slice(0, 2).map((t) => esc(t.title)).join(', ')}${d.overdue.length > 2 ? ' 외' : ''}</div></div>
      <button class="attn-fix" data-action="carry-over">오늘로</button></div>`);
  }

  // 현재 집중
  const r = d.running;
  const focusCard = r
    ? `<div class="side-card focus running">
        <div class="focus-head"><span class="pulse"></span>기록 중</div>
        <div class="focus-title">${esc(r.title)}</div>
        <div class="focus-time" data-elapsed="${esc(r.started_at)}">${elapsed(r.started_at)}</div>
        <button class="btn block" data-action="timer-stop">■ 정지</button></div>`
    : `<div class="side-card focus">
        <div class="focus-head">◷ 타이머 없음</div>
        <p class="muted">블록의 ▶ 를 누르면 시간을 기록해요. 기록은 선택이고, 직접 입력해도 돼요.</p>
        <button class="btn small" data-action="manual-log">+ 직접 기록</button></div>`;

  // 다음
  const n = d.next;
  const nextCard = n
    ? `<div class="side-card next">
        <div class="next-meta">◷ ${esc(n.start_time)} · ${fmtMin(n.minutes)}${n.now ? ' · <span class="accent">지금</span>' : ''}</div>
        <div class="next-title"><span class="dot" style="background:${blockColor(n)}"></span>${esc(n.title)}</div>
        ${r && r.event_id === n.id ? '<div class="muted" style="font-size:13px">타이머 기록 중</div>'
          : `<button class="btn primary block" data-action="timer-start" data-id="${n.id}">▶ 시작</button>`}</div>`
    : `<div class="side-card next"><p class="muted" style="margin:0 0 10px">오늘 남은 블록이 없어요.</p>
        <button class="btn small" data-action="plan-block">+ 블록 추가</button></div>`;

  // 오늘 할 일
  const todos = [...d.overdue, ...d.todayTodos];
  const todoCard = `<div class="side-card">
      ${todos.length ? `<ul class="todo-list compact">${todos.map(todoItem).join('')}</ul>` : '<p class="muted" style="margin:0">오늘 마감인 할 일이 없어요.</p>'}
      <form class="quick-add" data-form="quick-todo" data-date="${d.today}"><input type="text" name="title" placeholder="+ 오늘 할 일 추가" autocomplete="off"></form>
    </div>`;

  // 습관
  const habitCard = `<div class="side-card habits">
      ${d.habits.map((h) => `<div class="habit ${h.done ? 'done' : ''}">
        <button class="habit-check" data-action="toggle-habit" data-id="${h.id}" data-done="${h.done ? 1 : 0}" aria-label="체크">${h.done ? '✓' : ''}</button>
        <span class="habit-title" data-action="edit-habit" data-id="${h.id}" data-title="${esc(h.title)}">${esc(h.title)}</span></div>`).join('')}
      <form class="habit-add" data-form="habit-add"><input type="text" name="title" placeholder="+ 습관 추가 (예: 23:30 전에 자기)" autocomplete="off"></form>
    </div>`;

  return `
  <section class="home2">
    <header class="home2-head">
      <div><h1>${greeting(d.hour)}</h1><div class="sub">${esc(D.long(d.today))}</div></div>
      <div class="actions">
        ${d.overdue.length ? `<button class="btn" data-action="carry-over">↪ 미룬 일 가져오기 <span class="badge">${d.overdue.length}</span></button>` : ''}
        <button class="btn primary" data-action="plan-block">오늘 계획하기 →</button>
      </div>
    </header>

    <div class="home2-main">
      <div class="stats3">
        <div class="stat3"><div class="label">하루 진행률</div><div class="num accent">${pct}%</div>
          <div class="progress thin"><span style="width:${pct}%"></span></div>
          <div class="sub">블록 ${st.blocksTotal}개 중 ${st.blocksDone}개 완료</div></div>
        <div class="stat3"><div class="label">완료</div><div class="num">${fmtMin(st.completedMin)}</div>
          <div class="sub">계획 ${fmtMin(st.plannedMin)} · 남은 ${fmtMin(left)}</div></div>
        <div class="stat3"><div class="label">기록</div><div class="num" data-tracked="${st.trackedMin}">${fmtMin(st.trackedMin)}</div>
          <div class="sub">타이머 + 직접 기록</div></div>
      </div>

      <section class="card schedule">
        <div class="card-head"><h3>오늘 일정</h3>
          <div class="row" style="flex:none;gap:8px"><button class="btn small" data-action="plan-block">+ 블록</button><a class="link nowrap" href="#/calendar?d=${d.today}">캘린더</a></div></div>
        ${d.blocks.length || d.allDay.length ? '' : `<div class="empty" style="margin-bottom:12px">오늘 계획된 블록이 없어요. 빈 시간을 누르거나 아래 버튼으로 추가하세요.<button class="btn primary small" data-action="plan-block">첫 블록 추가</button></div>`}
        ${timeline(d)}
      </section>
    </div>

    <section class="card home2-proj">
      <div class="card-head"><h3>진행 중인 프로젝트</h3><a class="link" href="#/projects">전체 보기</a></div>
      ${d.projects.length ? `<div class="project-grid2">${d.projects.map((p) => projectCard(p)).join('')}</div>` : empty('진행 중인 프로젝트가 없어요.', '첫 프로젝트 추가', 'new-project')}
    </section>

    <aside class="home2-side">
      <h3>확인 필요</h3>
      ${attention.length ? attention.join('') : '<div class="side-card muted">확인할 것이 없어요. 👍</div>'}
      <h3>현재 집중</h3>${focusCard}
      <h3>다음</h3>${nextCard}
      <h3>오늘 할 일 <a class="link" href="#/todos?f=today">전체</a></h3>${todoCard}
      <h3>오늘 습관</h3>${habitCard}
    </aside>
  </section>`;
};

// 홈 화면을 처음 그릴 때 타임라인을 현재 시각 근처로 스크롤
afterRender.home = (sameView) => {
  const box = document.querySelector('.schedule .tl');
  if (!box || !homeData || sameView) return;
  const from = Number(box.querySelector('.tl-body').dataset.from);
  box.scrollTop = Math.max(0, ((toMin(homeData.now) - from * 60) / 60) * HOUR_PX - 120);
};

// ---------- 모달 ----------
function simpleModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}<div class="foot"><button type="button" class="btn" data-m="cancel">닫기</button></div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('[data-m=cancel]', root).onclick = close;
  $('.modal-backdrop', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
  return close;
}

async function slippedModal() {
  const d = await api('GET', '/api/today');
  if (!d.slipped.length) { $('#modal-root').innerHTML = ''; refresh(); return; }
  simpleModal(`<h3>지난 블록 정리</h3>
    <ul class="event-list">${d.slipped.map((e) => `<li class="event slipped-row"><div class="info" style="flex:1"><div class="title">${esc(e.title)}</div>
      <div class="meta">${esc(e.start_time)}${e.end_time ? '–' + esc(e.end_time) : ''}</div></div>
      <button class="btn small primary" data-action="slip-done" data-id="${e.id}">완료</button>
      <button class="btn small" data-action="slip-tomorrow" data-id="${e.id}">내일로</button></li>`).join('')}</ul>`);
}

function manualLogModal() {
  openModal(`<h3>시간 직접 기록</h3>
    <label class="field">무엇을 했나요<input type="text" name="title" required maxlength="300"></label>
    <label class="field">시간 (분)<input type="number" name="minutes" min="1" max="1440" value="30" required></label>`,
  async (v) => { await api('POST', '/api/logs', { title: v.title, minutes: Number(v.minutes) }); toast('기록했어요'); });
}

function habitModal(id, title) {
  openModal(`<h3>습관 수정</h3><label class="field">습관<input type="text" name="title" value="${esc(title)}" required maxlength="120"></label>`,
    async (v) => { await api('PUT', `/api/habits/${id}`, { title: v.title }); toast('수정했어요'); },
    async () => { await api('DELETE', `/api/habits/${id}`); toast('삭제했어요'); });
}

function planBlock(startMin) {
  const now = homeData ? toMin(homeData.now) : 9 * 60;
  const s = startMin ?? Math.min(23 * 60, Math.ceil((now + 1) / 30) * 30);
  eventModal({ date: today(), start: minToHHMM(s), end: minToHHMM(Math.min(s + 60, 23 * 60 + 59)) });
}

// ---------- 이벤트 ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  const handled = ['toggle-block', 'timer-start', 'timer-stop', 'manual-log', 'fix-slipped', 'slip-done', 'slip-tomorrow',
    'carry-over', 'plan-block', 'toggle-habit', 'edit-habit', 'tl-empty'];
  if (!handled.includes(action)) return;
  e.stopPropagation();
  try {
    switch (action) {
      case 'toggle-block': {
        const ev = cache.events.get(Number(id));
        await api('PUT', `/api/events/${id}`, { done: !(ev && ev.done) });
        refresh();
        break;
      }
      case 'timer-start': await api('POST', '/api/timer/start', { event_id: Number(id) }); toast('타이머 시작'); refresh(); break;
      case 'timer-stop': {
        const r = await api('POST', '/api/timer/stop');
        if (r.stopped) toast(`${r.stopped.title}: ${fmtMin(r.stopped.minutes)} 기록`);
        refresh();
        break;
      }
      case 'manual-log': manualLogModal(); break;
      case 'fix-slipped': slippedModal(); break;
      case 'slip-done': await api('PUT', `/api/events/${id}`, { done: true }); slippedModal(); refresh(); break;
      case 'slip-tomorrow': {
        const ev = cache.events.get(Number(id));
        await api('PUT', `/api/events/${id}`, { date: D.add(ev ? ev.date : today(), 1) });
        slippedModal(); refresh();
        break;
      }
      case 'carry-over': {
        const r = await api('POST', '/api/carry-over');
        toast(`할 일 ${r.moved}개를 오늘로 옮겼어요`);
        refresh();
        break;
      }
      case 'plan-block': planBlock(); break;
      case 'toggle-habit':
        await api('POST', `/api/habits/${id}/toggle`, { done: el.dataset.done !== '1', date: today() });
        refresh();
        break;
      case 'edit-habit': habitModal(id, el.dataset.title); break;
      case 'tl-empty': {
        // 빈 시간을 누르면 그 시각(30분 단위)에 블록 추가
        if (e.target !== el) return;
        const body = el.closest('.tl-body');
        const from = Number(body.dataset.from);
        const yPos = e.clientY - el.getBoundingClientRect().top;
        planBlock(Math.max(0, Math.floor(((yPos / HOUR_PX) * 60 + from * 60) / 30) * 30));
        break;
      }
    }
  } catch (err) { toast(err.message); }
}, true);

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('[data-form=habit-add]')) return;
  e.preventDefault();
  const input = f.querySelector('input');
  if (!input.value.trim()) return;
  try { await api('POST', '/api/habits', { title: input.value }); input.value = ''; await refresh(); } catch (err) { toast(err.message); }
});

// 타이머 시계는 매초, 홈 화면 전체는 1분마다 갱신 (입력 중이거나 모달이 열려 있으면 건너뜀)
setInterval(() => {
  document.querySelectorAll('[data-elapsed]').forEach((n) => { n.textContent = elapsed(n.dataset.elapsed); });
}, 1000);
setInterval(() => {
  const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (currentRoute.name === 'home' && !$('#modal-root').children.length && !typing) refresh();
}, 60_000);
