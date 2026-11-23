// 간트 차트 (프로젝트 상세 화면, 프로젝트 목록 화면). 외부 라이브러리 없이 HTML/CSS 로 그린다.
// 막대 위치는 차트 범위 안에서의 % 로 계산하므로, 확대 단계(전체/월/주)는 차트 폭만 바꾼다.
'use strict';

const gantt = {
  // 확대 단계: fit = 화면 폭에 맞춤, 나머지는 하루당 px
  ZOOMS: [['fit', '전체'], ['month', '월'], ['week', '주']],
  PX_PER_DAY: { month: 6, week: 26 },
  LABEL_W: 240,
  scrollLeft: null, // 같은 화면을 다시 그릴 때 가로 스크롤 유지

  get zoom() {
    try { const z = localStorage.getItem('gantt-zoom'); if (this.ZOOMS.some(([k]) => k === z)) return z; } catch { /* 저장소 없음 */ }
    return 'fit';
  },
  set zoom(z) { try { localStorage.setItem('gantt-zoom', z); } catch { /* 무시 */ } },

  days(a, b) { return Math.round((D.parse(b) - D.parse(a)) / 86400000); },
  min(...xs) { return xs.filter(Boolean).sort()[0] || null; },
  max(...xs) { return xs.filter(Boolean).sort().pop() || null; },
  // 월요일로 내림 / 일요일로 올림 → 주 눈금이 깔끔하게 맞는다
  weekStart(s) { return D.add(s, -((D.wd(s) + 6) % 7)); },
  weekEnd(s) { return D.add(s, (7 - D.wd(s)) % 7); },
  md(s) { const [, m, d] = s.split('-').map(Number); return `${m}/${d}`; },

  // 공통 차트. rows: [{ section } | { label, sub, start, end, type: 'bar'|'diamond', cls, attrs, fill, tip }]
  // markers: [{ date, label, cls }]
  chart({ start, end, rows, markers = [] }) {
    const total = this.days(start, end) + 1;
    const pos = (s) => (this.days(start, s) / total) * 100;
    const span = (s, e) => ((this.days(s, e) + 1) / total) * 100;
    const zoom = this.zoom;
    const trackW = zoom === 'fit' ? 0 : total * this.PX_PER_DAY[zoom];

    // 머리글: 월 + (여유가 있으면) 주 시작일
    const months = [];
    let yearShown = false;
    for (let m = D.month(start); m <= D.month(end); m = D.addMonth(m, 1)) {
      const s = this.max(`${m}-01`, start);
      const e = this.min(D.add(`${D.addMonth(m, 1)}-01`, -1), end);
      // 폭이 좁은 달(범위 끝에 며칠만 걸친 달 등)은 글자가 잘리므로 이름을 생략
      const short = zoom === 'fit' ? span(s, e) < 8 : (this.days(s, e) + 1) * this.PX_PER_DAY[zoom] < 70;
      const y = Number(m.slice(0, 4));
      const label = short ? '' : `${!yearShown || m.endsWith('-01') ? `${y}년 ` : ''}${Number(m.slice(5))}월`;
      if (!short) yearShown = true;
      months.push(`<div class="g-month" style="left:${pos(s)}%;width:${span(s, e)}%"><span>${label}</span></div>`);
    }
    const showWeeks = zoom === 'week' || zoom === 'month' || total <= 140;
    const weeks = [];
    const grid = [];
    for (let d = start; d <= end; d = D.add(d, 7)) {
      if (showWeeks) weeks.push(`<span class="g-week" style="left:${pos(d)}%">${zoom === 'week' ? this.md(d) : Number(d.slice(8))}</span>`);
      grid.push(`<span class="g-line ${d.endsWith('-01') ? 'month' : ''}" style="left:${pos(d)}%"></span>`);
    }
    // 월 경계선 (주 시작이 1일이 아닌 경우)
    for (let m = D.addMonth(D.month(start), 1); m <= D.month(end); m = D.addMonth(m, 1)) grid.push(`<span class="g-line month" style="left:${pos(`${m}-01`)}%"></span>`);
    // 주 단위 확대에서는 주말 음영
    if (zoom === 'week') for (let d = start; d <= end; d = D.add(d, 1)) if (D.wd(d) === 6) grid.push(`<span class="g-weekend" style="left:${pos(d)}%;width:${span(d, D.add(d, 1))}%"></span>`);

    const marks = markers.filter((m) => m.date >= start && m.date <= end).map((m) =>
      `<span class="g-marker ${m.cls || ''}" style="left:${pos(m.date) + span(m.date, m.date) / 2}%"><b>${esc(m.label)}</b></span>`).join('');

    const body = rows.map((r) => {
      if (r.section) return `<div class="g-row g-section"><div class="g-label">${esc(r.section)}</div><div class="g-track"></div></div>`;
      let mark = '';
      if (r.start && r.end) {
        const fill = r.fill != null ? `<i style="width:${Math.max(0, Math.min(100, r.fill))}%"></i>` : '';
        const inner = r.type === 'diamond' ? '' : `${fill}<em>${esc(r.barText || '')}</em>`;
        const style = r.type === 'diamond' ? `left:${pos(r.start) + span(r.start, r.start) / 2}%` : `left:${pos(r.start)}%;width:${span(r.start, r.end)}%`;
        mark = `<button class="g-${r.type || 'bar'} ${r.cls || ''}" style="${style}" ${r.attrs || ''} title="${esc(r.tip || r.label)}">${inner}</button>`;
      }
      return `<div class="g-row ${r.rowCls || ''}">
        <div class="g-label" ${r.attrs || ''}><div class="t">${esc(r.label)}</div>${r.sub ? `<div class="s">${esc(r.sub)}</div>` : ''}</div>
        <div class="g-track">${mark}</div></div>`;
    }).join('');

    return `<div class="gantt" style="--label-w:${this.LABEL_W}px">
      <div class="g-scroll" data-gantt-scroll>
        <div class="g-inner ${trackW ? '' : 'fit'}" style="${trackW ? `width:${this.LABEL_W + trackW}px` : ''}">
          <div class="g-row g-head"><div class="g-label"></div>
            <div class="g-track"><div class="g-months">${months.join('')}</div><div class="g-weeks">${weeks.join('')}</div></div></div>
          <div class="g-body">
            <div class="g-overlay">${grid.join('')}${marks}</div>
            <div class="g-row g-markrow"><div class="g-label"></div><div class="g-track"></div></div>
            ${body}
          </div>
        </div>
      </div>
    </div>`;
  },

  toolbar(extra = '') {
    return `<div class="g-tools">${extra}<div class="seg">${this.ZOOMS.map(([k, l]) =>
      `<button class="${k === this.zoom ? 'active' : ''}" data-gantt-zoom="${k}">${l}</button>`).join('')}</div></div>`;
  },

  // ---------- 프로젝트 하나 ----------
  project(p) {
    const t0 = today();
    const todos = p.todos.slice();
    const events = p.all_events || [];
    todos.forEach((t) => cache.todos.set(t.id, t));
    events.forEach((e) => cache.events.set(e.id, e));

    const dated = todos.filter((t) => t.start_date || t.due_date);
    const undated = todos.filter((t) => !t.start_date && !t.due_date);
    const created = p.created_at ? p.created_at.slice(0, 10) : t0;
    const projStart = p.start_date || this.min(created, ...dated.map((t) => t.start_date || t.due_date), ...events.map((e) => e.date));
    const projEnd = p.due_date || this.max(t0, ...dated.map((t) => t.due_date || t.start_date), ...events.map((e) => e.date));
    // 차트 범위 = 프로젝트 기간 + 범위를 벗어난 항목 + 오늘, 앞뒤 여유
    const lo = this.min(projStart, t0, ...dated.map((t) => t.start_date || t.due_date), ...events.map((e) => e.date));
    const hi = this.max(projEnd, t0, ...dated.map((t) => t.due_date || t.start_date), ...events.map((e) => e.date));
    const start = this.weekStart(D.add(lo, -3));
    let end = this.weekEnd(D.add(hi, 3));
    if (this.days(start, end) < 27) end = this.weekEnd(D.add(start, 27));

    const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
    const rows = [{
      label: '프로젝트 전체', sub: `${this.md(projStart)} ~ ${p.due_date ? this.md(p.due_date) : '마감 미정'} · ${this.days(projStart, projEnd) + 1}일`,
      start: projStart, end: projEnd, cls: `summary ${p.due_date ? '' : 'open-end'}`, fill: pct, barText: `${pct}%`, rowCls: 'summary-row',
      attrs: `data-action="edit-project" data-id="${p.id}"`, tip: `${p.name} · 진행률 ${pct}% (눌러서 기간 수정)`,
    }];

    const order = (t) => t.start_date || t.due_date;
    const openT = dated.filter((t) => !t.done).sort((a, b) => order(a).localeCompare(order(b)) || a.id - b.id);
    const doneT = dated.filter((t) => t.done).sort((a, b) => order(a).localeCompare(order(b)) || a.id - b.id);
    if (openT.length || doneT.length) rows.push({ section: `할 일 ${dated.length}` });
    for (const t of [...openT, ...doneT]) {
      const s = t.start_date || t.due_date;
      const e = t.due_date || t.start_date;
      const overdue = !t.done && t.due_date && t.due_date < t0;
      const range = t.start_date && t.due_date ? `${this.md(s)} ~ ${this.md(e)} · ${this.days(s, e) + 1}일`
        : t.due_date ? `마감 ${this.md(e)} · 시작일 없음` : `시작 ${this.md(s)} · 마감 없음`;
      const state = t.done ? 'done' : overdue ? 'overdue' : s <= t0 ? 'active' : 'future';
      const only = !(t.start_date && t.due_date);
      rows.push({
        label: `${t.done ? '✓ ' : ''}${t.title}`, sub: `${overdue ? '지연 · ' : ''}${range}`,
        start: s, end: e, type: only ? 'diamond' : 'bar', cls: state,
        rowCls: t.done ? 'is-done' : '', attrs: `data-action="edit-todo" data-id="${t.id}"`,
        tip: `${t.title} · ${range}${only ? ' (시작일과 마감일을 모두 넣으면 기간 막대로 보여요)' : ''}`,
        barText: t.title,
      });
    }
    if (events.length) rows.push({ section: `일정 ${events.length}` });
    for (const e of events) {
      rows.push({
        label: e.title, sub: `${D.short(e.date)} · ${fmtTime(e)}`, start: e.date, end: e.date, type: 'diamond',
        cls: `ev ${e.date < t0 ? 'past' : ''}`, attrs: `data-action="edit-event" data-id="${e.id}"`, tip: `${e.title} · ${D.long(e.date)} ${fmtTime(e)}`,
      });
    }

    const markers = [{ date: t0, label: `오늘 ${this.md(t0)}`, cls: 'today' }];
    if (p.start_date) markers.push({ date: p.start_date, label: `시작 ${this.md(p.start_date)}`, cls: 'start' });
    if (p.due_date) markers.push({ date: p.due_date, label: `마감 ${this.md(p.due_date)}`, cls: 'deadline' });

    const emptyNote = !dated.length && !events.length
      ? `<div class="g-empty">아직 날짜가 있는 할 일이 없어요. 아래에서 <b>시작일·마감일</b>과 함께 할 일을 추가하면 막대로 표시됩니다.</div>` : '';
    const undatedNote = undated.length ? `<div class="g-undated"><span class="muted">날짜 없는 할 일 ${undated.length}개 · 눌러서 날짜를 넣으세요</span>
      ${undated.map((t) => { cache.todos.set(t.id, t); return `<button class="chip ${t.done ? 'done' : ''}" data-action="edit-todo" data-id="${t.id}">${t.done ? '✓ ' : ''}${esc(t.title)}</button>`; }).join('')}</div>` : '';

    return `<section class="card gantt-card">
      <div class="card-head"><h3>전체 흐름 <span class="dim" style="font-weight:400">${this.md(projStart)} ~ ${p.due_date ? this.md(p.due_date) : '마감 미정'}</span></h3>
        ${this.toolbar(!p.start_date ? `<button class="btn small" data-action="edit-project" data-id="${p.id}">시작일 지정</button>` : '')}</div>
      ${this.chart({ start, end, rows, markers })}
      ${emptyNote}
      ${undatedNote}
      <form class="quick-add" data-form="quick-todo" data-project="${p.id}">
        <input type="text" name="title" placeholder="할 일 추가 후 Enter" autocomplete="off">
        <label class="qa-date"><span>시작</span><input type="date" name="start_date"></label>
        <label class="qa-date"><span>마감</span><input type="date" name="due_date"></label>
        <button class="btn primary">추가</button>
      </form>
      <div class="g-legend"><span><i class="lg active"></i>진행 중</span><span><i class="lg future"></i>예정</span><span><i class="lg overdue"></i>지연</span>
        <span><i class="lg done"></i>완료</span><span><i class="lg dia"></i>마감만 있음</span><span><i class="lg dia ev"></i>일정</span></div>
    </section>`;
  },

  // ---------- 전체 프로젝트 ----------
  projects(list) {
    if (!list.length) return '';
    const t0 = today();
    const items = list.map((p) => {
      const created = p.created_at ? p.created_at.slice(0, 10) : t0;
      const s = p.start_date || this.min(created, p.first_date);
      const e = p.due_date || this.max(t0, p.last_date, s);
      return { p, s: this.min(s, e), e };
    });
    const start = this.weekStart(D.add(this.min(t0, ...items.map((x) => x.s)), -3));
    let end = this.weekEnd(D.add(this.max(t0, ...items.map((x) => x.e)), 3));
    if (this.days(start, end) < 27) end = this.weekEnd(D.add(start, 27));
    const rows = items.map(({ p, s, e }) => {
      const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
      const late = p.status !== 'done' && p.due_date && p.due_date < t0;
      return {
        label: p.name, sub: `${STATUS_KO[p.status]} · ${p.completed}/${p.total} · ${this.md(s)} ~ ${p.due_date ? this.md(p.due_date) : '마감 미정'}`,
        start: s, end: e, fill: pct, barText: `${pct}%`,
        cls: `summary ${p.status === 'done' ? 'done' : late ? 'overdue' : p.status === 'paused' ? 'paused' : ''} ${p.due_date ? '' : 'open-end'}`,
        attrs: `data-gantt-goto="${p.id}"`, tip: `${p.name} · 진행률 ${pct}%`,
      };
    });
    return `<section class="card gantt-card" style="margin-bottom:16px">
      <div class="card-head"><h3>전체 흐름</h3>${this.toolbar()}</div>
      ${this.chart({ start, end, rows, markers: [{ date: t0, label: `오늘 ${this.md(t0)}`, cls: 'today' }] })}
    </section>`;
  },

  // 확대 단계를 바꾸지 않았다면 이전 가로 스크롤 유지, 처음엔 오늘 위치로 스크롤
  afterRender(sameView) {
    const sc = document.querySelector('[data-gantt-scroll]');
    if (!sc) return;
    if (sameView && this.scrollLeft != null) { sc.scrollLeft = this.scrollLeft; return; }
    const today = sc.querySelector('.g-marker.today');
    if (today && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = Math.max(0, today.offsetLeft + this.LABEL_W - sc.clientWidth / 3);
    this.scrollLeft = sc.scrollLeft;
  },
};

document.addEventListener('scroll', (e) => {
  if (e.target instanceof Element && e.target.matches('[data-gantt-scroll]')) gantt.scrollLeft = e.target.scrollLeft;
}, true);

document.addEventListener('click', (e) => {
  const z = e.target.closest('[data-gantt-zoom]');
  if (z) { gantt.zoom = z.dataset.ganttZoom; gantt.scrollLeft = null; render(); return; }
  const g = e.target.closest('[data-gantt-goto]');
  if (g) location.hash = `#/projects/${g.dataset.ganttGoto}`;
});

afterRender.project = (sameView) => gantt.afterRender(sameView);
afterRender.projects = (sameView) => gantt.afterRender(sameView);
