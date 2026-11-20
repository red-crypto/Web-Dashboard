// OpenAI 호출 (서버에서만). API 키는 환경변수 OPENAI_API_KEY 에서 읽는다.
// 등록 요청은 바로 저장하지 않고 "제안(proposal)"으로 돌려준다 → 사용자가 [등록]을 눌러야 저장.

const db = require('./db');
const time = require('./time');

const API_KEY = () => process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

class AiError extends Error {}

// ---------- 화면에서 고른 "참고 범위"를 텍스트 컨텍스트로 ----------
function fmtTodo(t) {
  const bits = [`#${t.id} ${t.title}`];
  if (t.due_date) bits.push(`마감 ${t.due_date}`); else bits.push('마감 없음');
  if (t.project_name) bits.push(`프로젝트: ${t.project_name}`);
  if (t.done) bits.push('완료');
  return '- ' + bits.join(' | ');
}
function fmtEvent(e) {
  const when = e.start_time ? `${e.date} ${e.start_time}${e.end_time ? '~' + e.end_time : ''}` : `${e.date} (종일)`;
  return `- ${when} ${e.title}${e.project_name ? ' | 프로젝트: ' + e.project_name : ''}`;
}
const list = (rows, f, empty = '- (없음)') => (rows.length ? rows.map(f).join('\n') : empty);

function resolveScope(scope) {
  const type = scope && scope.type;
  if (type === 'project') {
    const p = db.getProject(Number(scope.projectId));
    if (!p) throw new db.ValidationError('참고할 프로젝트를 찾을 수 없습니다.');
    return { type, project: p, label: `프로젝트: ${p.name}` };
  }
  if (type === 'all') return { type, label: '전체 데이터' };
  return { type: 'today', label: '오늘 할 일' };
}

function buildContext(scope) {
  const today = time.today();
  const lines = [];
  lines.push(`현재: ${today} (${time.WEEKDAY_KO[time.weekday(today)]}요일) ${time.nowTime()}, 시간대 ${time.TZ}`);
  const projects = db.listProjects();
  lines.push('\n[프로젝트 목록 (id: 이름 · 상태 · 완료/전체)]');
  lines.push(list(projects, (p) => `- ${p.id}: ${p.name} · ${p.status} · ${p.completed}/${p.total}${p.due_date ? ' · 마감 ' + p.due_date : ''}`));

  if (scope.type === 'project') {
    const p = scope.project;
    lines.push(`\n[현재 프로젝트] ${p.name} (id ${p.id})`);
    lines.push(`목표: ${p.goal || '(미입력)'}`);
    lines.push(`마감: ${p.due_date || '(없음)'}, 진행: ${p.completed}/${p.total}`);
    lines.push('\n[미완료 할 일]');
    lines.push(list(p.todos.filter((t) => !t.done), fmtTodo));
    lines.push('\n[완료한 할 일 (최근)]');
    lines.push(list(p.todos.filter((t) => t.done).slice(0, 15), fmtTodo));
    lines.push('\n[이 프로젝트의 다가오는 일정]');
    lines.push(list(p.events, fmtEvent));
  } else if (scope.type === 'all') {
    lines.push('\n[미완료 할 일 전체]');
    lines.push(list(db.listTodos({ filter: 'today' }).concat(db.listTodos({ filter: 'upcoming' })).slice(0, 80), fmtTodo));
    lines.push('\n[30일 내 일정]');
    lines.push(list(db.listEvents({ from: today, to: time.addDays(today, 30) }), fmtEvent));
  } else {
    const h = db.home();
    lines.push('\n[기한이 지난 미완료 할 일]');
    lines.push(list(h.overdue, fmtTodo));
    lines.push('\n[오늘 마감 할 일]');
    lines.push(list(h.todayTodos, fmtTodo));
    lines.push('\n[7일 내 마감 할 일]');
    lines.push(list(db.all(`SELECT t.*, p.name AS project_name FROM todos t LEFT JOIN projects p ON p.id = t.project_id
                            WHERE t.done = 0 AND t.due_date > ? AND t.due_date <= ? ORDER BY t.due_date`, today, time.addDays(today, 7)), fmtTodo));
    lines.push('\n[가까운 일정 (오늘~7일)]');
    lines.push(list(db.listEvents({ from: today, to: time.addDays(today, 7) }), fmtEvent));
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `당신은 1인용 개인 대시보드의 비서입니다. 한국어로, 짧고 실용적으로 답합니다.
- 아래 [데이터]만 근거로 답하고, 없는 할 일이나 일정을 지어내지 않습니다.
- "오늘 뭐부터 할까?" 같은 질문에는 기한 지난 항목, 오늘 마감, 가까운 일정(시간 제약)을 고려해 순서를 번호 목록으로 제시하고 각 항목에 이유를 한 줄로 답니다.
- "다음에 뭘 해야 해?" 같은 질문에는 프로젝트 목표와 미완료 할 일을 근거로 다음 작업 1~3개를 제안합니다.
- 일정이나 할 일을 "등록/추가/잡아줘" 요청하면 반드시 propose_event 또는 propose_todo 도구를 호출합니다.
  날짜는 현재 날짜 기준으로 계산해 YYYY-MM-DD, 시간은 24시간제 HH:MM 으로 넣습니다 ("오후 3시" → "15:00").
  도구 호출은 미리보기일 뿐이며 사용자가 [등록] 버튼을 눌러야 저장됩니다. "저장했습니다"라고 말하지 말고 "아래 내용을 확인 후 등록을 눌러주세요"처럼 안내합니다.
  관련 프로젝트가 명확하면 project_id 를 넣습니다.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'propose_event',
      description: '캘린더에 일정을 등록하자고 제안한다 (사용자 확인 후 저장).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '일정 제목' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM (24시간제). 종일이면 생략' },
          end_time: { type: 'string', description: 'HH:MM. 모르면 생략' },
          project_id: { type: 'integer', description: '관련 프로젝트 id. 없으면 생략' },
        },
        required: ['title', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_todo',
      description: '할 일을 추가하자고 제안한다 (사용자 확인 후 저장).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '할 일 내용' },
          due_date: { type: 'string', description: 'YYYY-MM-DD. 없으면 생략' },
          project_id: { type: 'integer', description: '관련 프로젝트 id. 없으면 생략' },
        },
        required: ['title'],
      },
    },
  },
];

// 모델이 준 도구 인자를 검증해서 저장 가능한 payload 로 정리
function toProposal(call) {
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return null; }
  const title = typeof args.title === 'string' ? args.title.trim().slice(0, 300) : '';
  if (!title) return null;
  const projectId = Number.isInteger(args.project_id) && db.get('SELECT id FROM projects WHERE id = ?', args.project_id)
    ? args.project_id : null;
  const projectName = projectId ? db.get('SELECT name FROM projects WHERE id = ?', projectId).name : null;
  if (call.function.name === 'propose_event') {
    if (!time.isDate(args.date)) return null;
    return {
      kind: 'event',
      payload: {
        title, date: args.date,
        start_time: time.isTime(args.start_time) ? args.start_time : null,
        end_time: time.isTime(args.end_time) ? args.end_time : null,
        project_id: projectId, project_name: projectName,
      },
    };
  }
  if (call.function.name === 'propose_todo') {
    return {
      kind: 'todo',
      payload: { title, due_date: time.isDate(args.due_date) ? args.due_date : null, project_id: projectId, project_name: projectName },
    };
  }
  return null;
}

async function callOpenAI(body) {
  if (!API_KEY()) throw new AiError('OPENAI_API_KEY 환경변수가 설정되지 않았습니다. README의 "API 키 설정"을 확인하세요.');
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new AiError(`OpenAI 서버에 연결하지 못했습니다 (${e.name === 'TimeoutError' ? '시간 초과' : e.message}).`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : text.slice(0, 200);
    throw new AiError(`OpenAI 오류 ${res.status}: ${msg}`);
  }
  if (!data || !data.choices || !data.choices[0]) throw new AiError('OpenAI 응답 형식이 올바르지 않습니다.');
  return data.choices[0].message;
}

// 채팅 1회: 성공하면 대화에 저장하고 결과를 돌려준다. 실패하면 아무것도 저장하지 않는다.
async function chat({ conversationId, message, scope }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new db.ValidationError('메시지를 입력하세요.');
  if (text.length > 4000) throw new db.ValidationError('메시지가 너무 깁니다.');
  let cid = conversationId ? Number(conversationId) : null;
  if (cid && !db.getConversation(cid)) throw new db.ValidationError('대화를 찾을 수 없습니다.');

  const sc = resolveScope(scope);
  const history = cid
    ? db.all('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20', cid).reverse()
    : [];

  const reply = await callOpenAI({
    model: MODEL,
    temperature: 0.3,
    tools: TOOLS,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\n[참고 범위: ${sc.label}]\n[데이터]\n${buildContext(sc)}` },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ],
  });

  const proposals = (reply.tool_calls || []).map(toProposal).filter(Boolean);
  let answer = (reply.content || '').trim();
  if (!answer) answer = proposals.length ? '아래 내용을 확인하고 [등록]을 눌러주세요.' : '(빈 응답)';

  cid = db.saveExchange({ conversationId: cid, userText: text, scopeLabel: sc.label, assistantText: answer, proposals });
  return db.getConversation(cid);
}

// 설정 화면의 "연결 테스트"
async function testConnection() {
  if (!API_KEY()) return { ok: false, message: 'OPENAI_API_KEY 가 설정되지 않았습니다.' };
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, message: '연결 성공' };
    return { ok: false, message: `응답 코드 ${res.status} (키가 올바른지 확인하세요)` };
  } catch (e) {
    return { ok: false, message: `연결 실패: ${e.message}` };
  }
}

function status() {
  return { keyConfigured: !!API_KEY(), model: MODEL, baseUrl: BASE_URL };
}

module.exports = { chat, testConnection, status, AiError, buildContext, resolveScope };
