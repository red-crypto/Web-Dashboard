// 로컬 SQLite DB (Node 내장 node:sqlite 사용, 별도 설치 불필요).
// 파일 위치: data/dashboard.db (DB_PATH 환경변수로 변경 가능)

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const time = require('./time');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dashboard.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    goal       TEXT NOT NULL DEFAULT '',
    due_date   TEXT,                         -- YYYY-MM-DD
    status     TEXT NOT NULL DEFAULT 'active', -- active | paused | done
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    due_date   TEXT,                         -- YYYY-MM-DD, NULL = 날짜 없음
    done       INTEGER NOT NULL DEFAULT 0,
    done_at    TEXT,
    memo       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    date       TEXT NOT NULL,                -- YYYY-MM-DD
    start_time TEXT,                         -- HH:MM, NULL = 종일
    end_time   TEXT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    memo       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,           -- user | assistant
    content         TEXT NOT NULL,
    scope_label     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 채팅에서 나온 "등록 제안". status가 pending일 때만 실제 등록된다 (중복 생성 방지).
  CREATE TABLE IF NOT EXISTS proposals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,           -- event | todo
    payload         TEXT NOT NULL,           -- JSON
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | applied | dismissed
    created_ref     INTEGER,                 -- 생성된 events.id / todos.id
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 앱 설정 (예: 선택한 GPT 모델)
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_date);
  CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
`);

// ---------- 기존 DB 업그레이드 (컬럼 추가) ----------
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// 메시지를 보낼 때 고른 참고 범위 (today | all | project:<id>). 범위가 바뀌면 이전 대화를 GPT에 보내지 않기 위해 사용
addColumn('messages', 'scope_key', 'scope_key TEXT');

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const all = (sql, ...a) => db.prepare(sql).all(...a).map(plain);
const get = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? plain(r) : null; };
const run = (sql, ...a) => db.prepare(sql).run(...a);
function plain(r) { return { ...r }; }

class ValidationError extends Error {}
function fail(msg) { throw new ValidationError(msg); }

// ---------- 입력 검증 ----------
function str(v, name, { required = false, max = 500 } = {}) {
  if (v === undefined || v === null) { if (required) fail(`${name} 항목을 입력하세요.`); return undefined; }
  if (typeof v !== 'string') fail(`${name} 형식이 잘못되었습니다.`);
  const s = v.trim();
  if (required && !s) fail(`${name} 항목을 입력하세요.`);
  if (s.length > max) fail(`${name}이(가) 너무 깁니다.`);
  return s;
}
function optDate(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!time.isDate(v)) fail(`${name} 형식은 YYYY-MM-DD 입니다.`);
  return v;
}
function optTime(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!time.isTime(v)) fail(`${name} 형식은 HH:MM 입니다.`);
  return v;
}
function optProject(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !get('SELECT id FROM projects WHERE id = ?', id)) fail('프로젝트를 찾을 수 없습니다.');
  return id;
}
function buildUpdate(table, id, fields) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
}

// ---------- 프로젝트 ----------
const PROJECT_STATS = `
  SELECT p.*,
    (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id) AS total,
    (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.done = 1) AS completed
  FROM projects p`;

function nextTodo(projectId) {
  return get(`SELECT * FROM todos WHERE project_id = ? AND done = 0
              ORDER BY due_date IS NULL, due_date, id LIMIT 1`, projectId);
}
function withNext(p) { return { ...p, next: nextTodo(p.id) }; }

function listProjects({ status } = {}) {
  const rows = status
    ? all(`${PROJECT_STATS} WHERE p.status = ? ORDER BY p.due_date IS NULL, p.due_date, p.id`, status)
    : all(`${PROJECT_STATS} ORDER BY p.status = 'done', p.due_date IS NULL, p.due_date, p.id`);
  return rows.map(withNext);
}
function getProject(id) {
  const p = get(`${PROJECT_STATS} WHERE p.id = ?`, id);
  if (!p) return null;
  return {
    ...withNext(p),
    todos: all(`SELECT * FROM todos WHERE project_id = ? ORDER BY done, due_date IS NULL, due_date, id`, id),
    events: all(`SELECT * FROM events WHERE project_id = ? AND date >= ? ORDER BY date, start_time IS NOT NULL, start_time`, id, time.today()),
  };
}
const STATUSES = ['active', 'paused', 'done'];
function projectFields(b, creating) {
  const f = {
    name: str(b.name, '프로젝트명', { required: creating, max: 120 }),
    goal: str(b.goal, '목표', { max: 2000 }),
    due_date: optDate(b.due_date, '마감일'),
    status: b.status,
  };
  if (f.name === '' ) fail('프로젝트명을 입력하세요.');
  if (f.status !== undefined && !STATUSES.includes(f.status)) fail('상태 값이 잘못되었습니다.');
  return f;
}
function createProject(b) {
  const f = projectFields(b, true);
  const r = run('INSERT INTO projects (name, goal, due_date, status) VALUES (?, ?, ?, ?)',
    f.name, f.goal ?? '', f.due_date ?? null, f.status ?? 'active');
  return getProject(Number(r.lastInsertRowid));
}
function updateProject(id, b) {
  if (!get('SELECT id FROM projects WHERE id = ?', id)) return null;
  buildUpdate('projects', id, projectFields(b, false));
  return getProject(id);
}
function deleteProject(id) { return run('DELETE FROM projects WHERE id = ?', id).changes > 0; }

// ---------- 할 일 ----------
const TODO_SELECT = `SELECT t.*, p.name AS project_name FROM todos t LEFT JOIN projects p ON p.id = t.project_id`;

function listTodos({ filter = 'all', projectId, date } = {}) {
  const today = time.today();
  const where = [];
  const args = [];
  let order = 't.due_date IS NULL, t.due_date, t.id';
  switch (filter) {
    case 'today': where.push('t.done = 0 AND t.due_date IS NOT NULL AND t.due_date <= ?'); args.push(today); break;
    case 'upcoming': where.push('t.done = 0 AND (t.due_date IS NULL OR t.due_date > ?)'); args.push(today); break;
    case 'week': {
      const w = time.weekRange(today);
      where.push('t.done = 0 AND t.due_date BETWEEN ? AND ?'); args.push(w.start, w.end); break;
    }
    case 'done': where.push('t.done = 1'); order = 't.done_at DESC, t.id DESC'; break;
    case 'all': break;
    default: fail('필터 값이 잘못되었습니다.');
  }
  if (projectId) { where.push('t.project_id = ?'); args.push(projectId); }
  if (date) { where.push('t.due_date = ?'); args.push(date); }
  const sql = `${TODO_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
  return all(sql, ...args);
}
function getTodo(id) { return get(`${TODO_SELECT} WHERE t.id = ?`, id); }
function todoFields(b, creating) {
  const f = {
    title: str(b.title, '할 일', { required: creating, max: 300 }),
    project_id: optProject(b.project_id),
    due_date: optDate(b.due_date, '마감일'),
    memo: str(b.memo, '메모', { max: 2000 }),
  };
  if (f.title === '') fail('할 일을 입력하세요.');
  if (b.done !== undefined) {
    f.done = b.done ? 1 : 0;
    f.done_at = b.done ? new Date().toISOString() : null;
  }
  return f;
}
function insertTodo(f) {
  const r = run('INSERT INTO todos (title, project_id, due_date, memo) VALUES (?, ?, ?, ?)',
    f.title, f.project_id ?? null, f.due_date ?? null, f.memo ?? '');
  return Number(r.lastInsertRowid);
}
function createTodo(b) { return getTodo(insertTodo(todoFields(b, true))); }
function updateTodo(id, b) {
  if (!getTodo(id)) return null;
  buildUpdate('todos', id, todoFields(b, false));
  return getTodo(id);
}
function deleteTodo(id) { return run('DELETE FROM todos WHERE id = ?', id).changes > 0; }

// ---------- 일정 ----------
const EVENT_SELECT = `SELECT e.*, p.name AS project_name FROM events e LEFT JOIN projects p ON p.id = e.project_id`;
const EVENT_ORDER = 'ORDER BY e.date, e.start_time IS NOT NULL, e.start_time, e.id';

function listEvents({ from, to } = {}) {
  if (from && !time.isDate(from)) fail('from 형식 오류');
  if (to && !time.isDate(to)) fail('to 형식 오류');
  return all(`${EVENT_SELECT} WHERE e.date BETWEEN ? AND ? ${EVENT_ORDER}`, from || '0000-01-01', to || '9999-12-31');
}
function getEvent(id) { return get(`${EVENT_SELECT} WHERE e.id = ?`, id); }
function eventFields(b, creating) {
  const f = {
    title: str(b.title, '일정 제목', { required: creating, max: 300 }),
    date: optDate(b.date, '날짜'),
    start_time: optTime(b.start_time, '시작 시간'),
    end_time: optTime(b.end_time, '종료 시간'),
    project_id: optProject(b.project_id),
    memo: str(b.memo, '메모', { max: 2000 }),
  };
  if (f.title === '') fail('일정 제목을 입력하세요.');
  if (creating && !f.date) fail('날짜를 입력하세요.');
  if (f.date === null) fail('날짜를 입력하세요.');
  return f;
}
function insertEvent(f) {
  const r = run('INSERT INTO events (title, date, start_time, end_time, project_id, memo) VALUES (?, ?, ?, ?, ?, ?)',
    f.title, f.date, f.start_time ?? null, f.end_time ?? null, f.project_id ?? null, f.memo ?? '');
  return Number(r.lastInsertRowid);
}
function createEvent(b) { return getEvent(insertEvent(eventFields(b, true))); }
function updateEvent(id, b) {
  if (!getEvent(id)) return null;
  buildUpdate('events', id, eventFields(b, false));
  return getEvent(id);
}
function deleteEvent(id) { return run('DELETE FROM events WHERE id = ?', id).changes > 0; }

// ---------- 홈 ----------
function home() {
  const today = time.today();
  const week = time.weekRange(today);
  const overdue = all(`${TODO_SELECT} WHERE t.done = 0 AND t.due_date < ? ORDER BY t.due_date, t.id`, today);
  const todayTodos = all(`${TODO_SELECT} WHERE t.due_date = ? ORDER BY t.done, t.id`, today);
  const projects = listProjects({ status: 'active' });
  const upcoming = all(`${EVENT_SELECT} WHERE e.date >= ? ${EVENT_ORDER} LIMIT 8`, today);
  return {
    today,
    weekday: time.WEEKDAY_KO[time.weekday(today)],
    week,
    stats: {
      todayRemaining: overdue.length + todayTodos.filter((t) => !t.done).length,
      weekDue: get('SELECT COUNT(*) AS n FROM todos WHERE done = 0 AND due_date BETWEEN ? AND ?', week.start, week.end).n,
      activeProjects: projects.length,
    },
    overdue,
    todayTodos,
    projects,
    upcoming,
  };
}

// 캘린더(월): 일정 + 할 일 마감일
function calendar(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) fail('month 형식은 YYYY-MM 입니다.');
  const from = `${month}-01`;
  const to = `${month}-31`;
  return {
    month,
    events: all(`${EVENT_SELECT} WHERE e.date BETWEEN ? AND ? ${EVENT_ORDER}`, from, to),
    todos: all(`${TODO_SELECT} WHERE t.due_date BETWEEN ? AND ? ORDER BY t.due_date, t.done, t.id`, from, to),
  };
}

// ---------- 대화 ----------
function listConversations() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
              FROM conversations c ORDER BY c.updated_at DESC, c.id DESC`);
}
function getConversation(id) {
  const c = get('SELECT * FROM conversations WHERE id = ?', id);
  if (!c) return null;
  const messages = all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', id);
  const proposals = all('SELECT * FROM proposals WHERE conversation_id = ? ORDER BY id', id).map(parseProposal);
  return { ...c, messages: messages.map((m) => ({ ...m, proposals: proposals.filter((p) => p.message_id === m.id) })) };
}
function deleteConversation(id) { return run('DELETE FROM conversations WHERE id = ?', id).changes > 0; }
function parseProposal(p) { return { ...p, payload: JSON.parse(p.payload) }; }

// 사용자 메시지 + 응답 + 제안을 한 번에 저장 (API 성공 시에만 호출)
function saveExchange({ conversationId, userText, scopeLabel, scopeKey, assistantText, proposals }) {
  return tx(() => {
    let cid = conversationId;
    if (!cid) {
      const title = userText.length > 40 ? userText.slice(0, 40) + '…' : userText;
      cid = Number(run('INSERT INTO conversations (title) VALUES (?)', title).lastInsertRowid);
    } else {
      run(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`, cid);
    }
    run('INSERT INTO messages (conversation_id, role, content, scope_label, scope_key) VALUES (?, ?, ?, ?, ?)', cid, 'user', userText, scopeLabel, scopeKey);
    const mid = Number(run('INSERT INTO messages (conversation_id, role, content, scope_key) VALUES (?, ?, ?, ?)', cid, 'assistant', assistantText, scopeKey).lastInsertRowid);
    for (const p of proposals) {
      run('INSERT INTO proposals (conversation_id, message_id, kind, payload) VALUES (?, ?, ?, ?)', cid, mid, p.kind, JSON.stringify(p.payload));
    }
    return cid;
  });
}

// 제안 등록. 이미 등록된 제안이면 새로 만들지 않고 기존 결과를 돌려준다 → 연달아 눌러도 1건만 생성.
function applyProposal(id) {
  return tx(() => {
    const p = get('SELECT * FROM proposals WHERE id = ?', id);
    if (!p) return null;
    const payload = JSON.parse(p.payload);
    if (p.status === 'applied') return { proposal: parseProposal(p), already: true };
    if (p.status === 'dismissed') fail('취소된 제안입니다.');
    let ref;
    if (p.kind === 'event') ref = insertEvent(eventFields(payload, true));
    else if (p.kind === 'todo') ref = insertTodo(todoFields(payload, true));
    else fail('알 수 없는 제안 종류');
    const r = run(`UPDATE proposals SET status = 'applied', created_ref = ? WHERE id = ? AND status = 'pending'`, ref, id);
    if (r.changes !== 1) throw new Error('proposal state changed concurrently');
    return { proposal: parseProposal(get('SELECT * FROM proposals WHERE id = ?', id)), already: false };
  });
}
function dismissProposal(id) {
  const r = run(`UPDATE proposals SET status = 'dismissed' WHERE id = ? AND status = 'pending'`, id);
  const p = get('SELECT * FROM proposals WHERE id = ?', id);
  return p ? { proposal: parseProposal(p), changed: r.changes > 0 } : null;
}

// GPT에 함께 보낼 이전 대화: 가장 최근부터 거슬러 올라가며 "같은 범위"로 주고받은 메시지만 (최대 limit개).
// 범위가 다른 메시지를 만나면 거기서 멈춘다 → 범위를 바꾸면 이전 대화는 보내지 않는다.
function historyForScope(conversationId, scopeKey, limit = 20) {
  const rows = all('SELECT role, content, scope_key FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', conversationId, limit);
  const out = [];
  for (const m of rows) {
    if (m.scope_key !== scopeKey) break;
    out.push({ role: m.role, content: m.content });
  }
  return out.reverse();
}
// 대화의 마지막 메시지 범위 (화면에서 "범위가 바뀌었다" 안내용)
function lastScopeKey(conversationId) {
  const r = get('SELECT scope_key FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', conversationId);
  return r ? r.scope_key : null;
}

function getSetting(key) { const r = get('SELECT value FROM settings WHERE key = ?', key); return r ? r.value : null; }
function setSetting(key, value) {
  if (value === null || value === '') run('DELETE FROM settings WHERE key = ?', key);
  else run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

module.exports = {
  historyForScope, lastScopeKey, getSetting, setSetting,
  db, DB_PATH, ValidationError,
  listProjects, getProject, createProject, updateProject, deleteProject,
  listTodos, getTodo, createTodo, updateTodo, deleteTodo,
  listEvents, getEvent, createEvent, updateEvent, deleteEvent,
  home, calendar,
  listConversations, getConversation, deleteConversation, saveExchange,
  applyProposal, dismissProposal,
  // AI 컨텍스트용
  all, get,
};
