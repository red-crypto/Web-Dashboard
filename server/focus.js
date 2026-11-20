// 홈 화면용: 오늘의 시간 블록 요약, 타이머/시간 기록, 습관, 검색, 미룬 할 일 가져오기

const db = require('./db');
const time = require('./time');

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const DEFAULT_BLOCK_MIN = 60; // 종료 시간이 없는 블록은 1시간으로 계산

function blockMinutes(e) {
  if (!e.start_time) return 0;
  if (!e.end_time) return DEFAULT_BLOCK_MIN;
  return Math.max(0, toMin(e.end_time) - toMin(e.start_time));
}
function blockEnd(e) { return e.end_time ? toMin(e.end_time) : toMin(e.start_time) + DEFAULT_BLOCK_MIN; }

// ---------- 타이머 / 시간 기록 ----------
const LOG_SELECT = 'SELECT * FROM time_logs';

function running() { return db.get(`${LOG_SELECT} WHERE ended_at IS NULL AND started_at IS NOT NULL ORDER BY id DESC LIMIT 1`); }

function closeLog(log) {
  const now = new Date();
  const minutes = Math.max(0, Math.round((now - new Date(log.started_at)) / 60000));
  db.run('UPDATE time_logs SET ended_at = ?, minutes = ? WHERE id = ?', now.toISOString(), minutes, log.id);
}

function startTimer(b) {
  return db.tx(() => {
    const cur = running();
    if (cur) closeLog(cur); // 타이머는 하나만
    let eventId = null;
    let title = db.str(b.title, '제목', { max: 300 });
    if (b.event_id !== undefined && b.event_id !== null) {
      const e = db.getEvent(Number(b.event_id));
      if (!e) db.fail('블록을 찾을 수 없습니다.');
      eventId = e.id;
      title = title || e.title;
    }
    if (!title) db.fail('무엇을 하는지 입력하세요.');
    db.run('INSERT INTO time_logs (event_id, title, date, started_at) VALUES (?, ?, ?, ?)', eventId, title, time.today(), new Date().toISOString());
    return { running: running() };
  });
}

function stopTimer() {
  const cur = running();
  if (cur) closeLog(cur);
  return { running: null, stopped: cur ? db.get(`${LOG_SELECT} WHERE id = ?`, cur.id) : null };
}

function addLog(b) {
  const title = db.str(b.title, '제목', { required: true, max: 300 });
  const minutes = Number(b.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) db.fail('시간은 1~1440분 사이로 입력하세요.');
  const r = db.run('INSERT INTO time_logs (title, date, minutes) VALUES (?, ?, ?)', title, time.today(), minutes);
  return db.get(`${LOG_SELECT} WHERE id = ?`, Number(r.lastInsertRowid));
}

function trackedMinutes(date) {
  const done = db.get('SELECT COALESCE(SUM(minutes), 0) AS m FROM time_logs WHERE date = ? AND minutes IS NOT NULL', date).m;
  const cur = running();
  const live = cur && cur.date === date ? Math.max(0, Math.round((Date.now() - new Date(cur.started_at)) / 60000)) : 0;
  return done + live;
}

// ---------- 습관 ----------
function habits(date) {
  return db.all(`SELECT h.id, h.title, EXISTS(SELECT 1 FROM habit_checks c WHERE c.habit_id = h.id AND c.date = ?) AS done
                 FROM habits h ORDER BY h.id`, date).map((h) => ({ ...h, done: !!h.done }));
}
function createHabit(b) {
  const title = db.str(b.title, '습관', { required: true, max: 120 });
  const r = db.run('INSERT INTO habits (title) VALUES (?)', title);
  return db.get('SELECT * FROM habits WHERE id = ?', Number(r.lastInsertRowid));
}
function updateHabit(id, b) {
  if (!db.get('SELECT id FROM habits WHERE id = ?', id)) return null;
  const title = db.str(b.title, '습관', { required: true, max: 120 });
  db.run('UPDATE habits SET title = ? WHERE id = ?', title, id);
  return db.get('SELECT * FROM habits WHERE id = ?', id);
}
function deleteHabit(id) { return db.run('DELETE FROM habits WHERE id = ?', id).changes > 0; }
function toggleHabit(id, b) {
  if (!db.get('SELECT id FROM habits WHERE id = ?', id)) return null;
  const date = b.date || time.today();
  if (!time.isDate(date)) db.fail('날짜 형식 오류');
  const done = !!b.done;
  if (done) db.run('INSERT OR IGNORE INTO habit_checks (habit_id, date) VALUES (?, ?)', id, date);
  else db.run('DELETE FROM habit_checks WHERE habit_id = ? AND date = ?', id, date);
  return { id, date, done };
}

// ---------- 오늘 요약 (홈) ----------
function today() {
  const date = time.today();
  const nowMin = toMin(time.nowTime());
  const events = db.listEvents({ from: date, to: date });
  const blocks = events.filter((e) => e.start_time);
  const allDay = events.filter((e) => !e.start_time);
  const planned = blocks.reduce((s, e) => s + blockMinutes(e), 0);
  const completed = blocks.filter((e) => e.done).reduce((s, e) => s + blockMinutes(e), 0);
  const slipped = blocks.filter((e) => !e.done && blockEnd(e) <= nowMin);
  const next = blocks.filter((e) => !e.done && blockEnd(e) > nowMin)
    .map((e) => ({ ...e, minutes: blockMinutes(e), now: toMin(e.start_time) <= nowMin }))[0] || null;
  const base = db.home();
  return {
    ...base,
    now: time.nowTime(),
    hour: Math.floor(nowMin / 60),
    blocks: blocks.map((e) => ({ ...e, minutes: blockMinutes(e) })),
    allDay,
    dayStats: {
      blocksTotal: blocks.length,
      blocksDone: blocks.filter((e) => e.done).length,
      plannedMin: planned,
      completedMin: completed,
      trackedMin: trackedMinutes(date),
    },
    slipped,
    next,
    running: running(),
    habits: habits(date),
  };
}

// 기한이 지난 미완료 할 일을 오늘로 옮긴다
function carryOver() {
  const date = time.today();
  const r = db.run('UPDATE todos SET due_date = ? WHERE done = 0 AND due_date < ?', date, date);
  return { moved: r.changes };
}

// ---------- 검색 ----------
function search(q) {
  q = String(q || '').trim();
  if (!q) return { todos: [], events: [], projects: [] };
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  return {
    todos: db.all(`SELECT t.*, p.name AS project_name FROM todos t LEFT JOIN projects p ON p.id = t.project_id
                   WHERE t.title LIKE ? ESCAPE '\\' OR t.memo LIKE ? ESCAPE '\\' ORDER BY t.done, t.due_date IS NULL, t.due_date DESC LIMIT 15`, like, like),
    events: db.all(`SELECT e.*, p.name AS project_name FROM events e LEFT JOIN projects p ON p.id = e.project_id
                    WHERE e.title LIKE ? ESCAPE '\\' OR e.memo LIKE ? ESCAPE '\\' ORDER BY e.date DESC LIMIT 15`, like, like),
    projects: db.all(`SELECT * FROM projects WHERE name LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 10`, like, like),
  };
}

module.exports = {
  today, carryOver, search,
  startTimer, stopTimer, addLog, running,
  habits, createHabit, updateHabit, deleteHabit, toggleHabit,
};
