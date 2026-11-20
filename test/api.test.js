// 서버 API 통합 테스트. 실행: npm test
// 실제 OpenAI 대신 가짜 OpenAI 서버를 띄워 채팅/등록 흐름을 검증한다 (API 키 불필요).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
let fake, fakePort, srv;
let lastPrompt = '';
let lastBody = null;
let lastPath = '';

function seoulToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}

function startServer() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'test.db'), OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}/v1` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    srv.stdout.on('data', (d) => { if (String(d).includes('실행 중')) resolve(); });
    srv.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}

before(async () => {
  fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-6-luna' }, { id: 'text-embedding-3-small' }] }));
      const body = JSON.parse(b || '{}');
      lastBody = body;
      lastPath = req.url;
      // 실제 OpenAI처럼: Responses API(/v1/responses)가 기본, 'legacy-only' 모델은 /responses 를 모르는 서버 흉내(404)
      const isResponses = req.url.endsWith('/responses');
      if (isResponses && body.model === 'legacy-only') { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'Not found' } })); }
      const msgs = isResponses ? body.input : body.messages;
      lastPrompt = isResponses ? body.instructions : body.messages[0].content;
      const user = msgs[msgs.length - 1].content;
      if (user.includes('FAIL')) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'boom' } })); }
      let text = '1. 지연된 항목부터 처리하세요.';
      let call = null;
      if (user.includes('등록')) {
        text = '';
        call = { name: 'propose_event', arguments: JSON.stringify({ title: '프로젝트 회의', date: addDays(seoulToday(), 1), start_time: '15:00' }) };
      }
      if (isResponses) {
        const output = [{ type: 'reasoning', id: 'rs_1', summary: [] }];
        if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
        if (call) output.push({ type: 'function_call', call_id: 'c1', ...call });
        return res.end(JSON.stringify({ id: 'resp_1', output }));
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text || null, tool_calls: call ? [{ id: 'c1', type: 'function', function: call }] : undefined } }] }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  await startServer();
});
after(() => { srv.kill(); fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('프로젝트·할 일·일정 저장 및 홈 통계 갱신', async () => {
  const today = seoulToday();
  const p = (await api('POST', '/api/projects', { name: '펌웨어', goal: '부트로더 개선' })).data;
  const t1 = (await api('POST', '/api/todos', { title: '오늘 작업', project_id: p.id, due_date: today })).data;
  await api('POST', '/api/todos', { title: '지연 작업', project_id: p.id, due_date: addDays(today, -2) });
  await api('POST', '/api/events', { title: '리뷰', date: today, start_time: '10:00' });

  let h = (await api('GET', '/api/home')).data;
  assert.equal(h.stats.todayRemaining, 2);
  assert.equal(h.overdue.length, 1);
  assert.equal(h.projects[0].completed, 0);
  assert.equal(h.projects[0].total, 2);

  await api('PUT', `/api/todos/${t1.id}`, { done: true });
  h = (await api('GET', '/api/home')).data;
  assert.equal(h.stats.todayRemaining, 1);
  assert.equal(h.projects[0].completed, 1);

  // 마감일 수정 → 캘린더 반영
  const nm = addDays(today, 3);
  await api('PUT', `/api/todos/${t1.id}`, { due_date: nm });
  const cal = (await api('GET', `/api/calendar?month=${nm.slice(0, 7)}`)).data;
  assert.ok(cal.todos.some((t) => t.id === t1.id && t.due_date === nm));

  const bad = await api('POST', '/api/events', { title: 'x', date: '2026-02-30' });
  assert.equal(bad.status, 400);
});

test('채팅: 우선순위 질문은 오늘 데이터를 참고한다', async () => {
  const r = await api('POST', '/api/chat', { message: '오늘 뭐부터 할까?', scope: { type: 'today' } });
  assert.equal(r.status, 200);
  assert.match(lastPrompt, /지연 작업/);
  assert.equal(r.data.messages.length, 2);
});

test('채팅: 일정 제안 → 등록 연타해도 1건만 생성', async () => {
  const before = (await api('GET', '/api/events')).data.length;
  const r = await api('POST', '/api/chat', { message: '내일 오후 3시에 프로젝트 회의 등록해줘.', scope: { type: 'today' } });
  const prop = r.data.messages.at(-1).proposals[0];
  assert.equal(prop.kind, 'event');
  assert.equal(prop.payload.start_time, '15:00');
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', `/api/proposals/${prop.id}/apply`)));
  assert.ok(results.every((x) => x.status === 200));
  assert.equal(results.filter((x) => !x.data.already).length, 1);
  const evs = (await api('GET', '/api/events')).data;
  assert.equal(evs.length, before + 1);
  const h = (await api('GET', '/api/home')).data;
  assert.ok(h.upcoming.some((e) => e.title === '프로젝트 회의'));
});

test('채팅: API 오류 시 502 + 아무것도 저장하지 않음', async () => {
  const convs = (await api('GET', '/api/conversations')).data.length;
  const r = await api('POST', '/api/chat', { message: 'FAIL please', scope: { type: 'today' } });
  assert.equal(r.status, 502);
  assert.equal(r.data.retryable, true);
  assert.equal((await api('GET', '/api/conversations')).data.length, convs);
});

test('잘못된 URL 인코딩은 400을 돌려주고 서버는 계속 동작', async () => {
  const r = await fetch(BASE + '/%ZZ');
  assert.equal(r.status, 400);
  const h = await api('GET', '/api/home');
  assert.equal(h.status, 200);
});

test('JSON이 아닌 변경 요청은 거부 (다른 사이트의 몰래 호출 방지)', async () => {
  const r = await fetch(BASE + '/api/todos', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"title":"x"}' });
  assert.equal(r.status, 415);
});

test('이미 실행 중이면 두 번째 실행은 정상 종료 (바탕화면 아이콘 재클릭)', async () => {
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'test.db') }, stdio: 'ignore',
    });
    p.on('exit', resolve);
  });
  assert.equal(code, 0);
  assert.equal((await api('GET', '/api/home')).status, 200);
});

test('참고 범위: 현재 프로젝트를 고르면 다른 프로젝트 정보는 보내지 않음', async () => {
  const a = (await api('POST', '/api/projects', { name: '알파 프로젝트' })).data;
  await api('POST', '/api/projects', { name: '비밀 베타 프로젝트' });
  await api('POST', '/api/chat', { message: '다음에 뭘 해야 해?', scope: { type: 'project', projectId: a.id } });
  assert.match(lastPrompt, /알파 프로젝트/);
  assert.doesNotMatch(lastPrompt, /비밀 베타 프로젝트/);
  await api('POST', '/api/chat', { message: '오늘 뭐부터 할까?', scope: { type: 'today' } });
  assert.doesNotMatch(lastPrompt, /비밀 베타 프로젝트/);
  await api('POST', '/api/chat', { message: '전체 요약', scope: { type: 'all' } });
  assert.match(lastPrompt, /비밀 베타 프로젝트/);
});

test('범위를 바꾸면 이전 대화는 기본적으로 보내지 않음', async () => {
  const p = (await api('POST', '/api/projects', { name: '히스토리 테스트' })).data;
  const c = (await api('POST', '/api/chat', { message: '첫 질문', scope: { type: 'today' } })).data;
  await api('POST', '/api/chat', { conversationId: c.id, message: '두번째', scope: { type: 'today' } });
  assert.equal(lastBody.input.length, 3); // 이전 2개 + 새 질문 (시스템 지시는 instructions 로 따로)
  await api('POST', '/api/chat', { conversationId: c.id, message: '프로젝트 질문', scope: { type: 'project', projectId: p.id } });
  assert.equal(lastBody.input.length, 1); // 새 질문만
  assert.ok(!JSON.stringify(lastBody.input).includes('첫 질문'));
  await api('POST', '/api/chat', { conversationId: c.id, message: '오늘로 다시', scope: { type: 'today' }, includeHistory: true });
  assert.ok(JSON.stringify(lastBody.input).includes('첫 질문'));
  assert.equal(lastBody.temperature, undefined);
});

test('GPT 모델 선택', async () => {
  const models = (await api('GET', '/api/settings/models')).data;
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-4o-mini']);
  const st = (await api('PUT', '/api/settings/model', { model: 'gpt-6-luna' })).data;
  assert.equal(st.model, 'gpt-6-luna');
  await api('POST', '/api/chat', { message: '모델 확인', scope: { type: 'today' } });
  assert.equal(lastBody.model, 'gpt-6-luna');
  assert.equal((await api('PUT', '/api/settings/model', { model: 'bad model; drop' })).status, 400);
  assert.equal((await api('PUT', '/api/settings/model', { model: '' })).data.model, 'gpt-4o-mini');
});

test('홈: 시간 블록 완료, 타이머, 직접 기록, 습관, 미룬 일 가져오기, 검색', async () => {
  const today = seoulToday();
  const ev = (await api('POST', '/api/events', { title: '집중 블록', date: today, start_time: '00:00', end_time: '00:30' })).data;
  let d = (await api('GET', '/api/today')).data;
  const seoulHM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (seoulHM >= '00:31') assert.ok(d.slipped.some((e) => e.id === ev.id)); // 이미 지난 블록 (자정 직후 실행 시 제외)
  await api('PUT', `/api/events/${ev.id}`, { done: true });
  d = (await api('GET', '/api/today')).data;
  assert.ok(!d.slipped.some((e) => e.id === ev.id));
  assert.ok(d.dayStats.completedMin >= 30);

  const r = (await api('POST', '/api/timer/start', { event_id: ev.id })).data;
  assert.equal(r.running.event_id, ev.id);
  await api('POST', '/api/timer/start', { title: '다른 일' }); // 타이머는 하나만
  assert.equal((await api('GET', '/api/today')).data.running.title, '다른 일');
  const stop = (await api('POST', '/api/timer/stop')).data;
  assert.equal(stop.running, null);
  await api('POST', '/api/logs', { title: '독서', minutes: 25 });
  assert.ok((await api('GET', '/api/today')).data.dayStats.trackedMin >= 25);
  assert.equal((await api('POST', '/api/logs', { title: 'x', minutes: 0 })).status, 400);

  const h = (await api('POST', '/api/habits', { title: '물 마시기' })).data;
  await api('POST', `/api/habits/${h.id}/toggle`, { done: true });
  assert.ok((await api('GET', '/api/today')).data.habits.find((x) => x.id === h.id).done);

  await api('POST', '/api/todos', { title: '어제 못한 일', due_date: addDays(today, -1) });
  const moved = (await api('POST', '/api/carry-over')).data.moved;
  assert.ok(moved >= 1);
  assert.equal((await api('GET', '/api/today')).data.overdue.length, 0);

  const s = (await api('GET', `/api/search?q=${encodeURIComponent('어제 못한')}`)).data;
  assert.equal(s.todos[0].title, '어제 못한 일');
  assert.equal((await api('GET', `/api/search?q=${encodeURIComponent('%')}`)).data.todos.length, 0);
});

test('Responses API 로 도구 호출 (추론 모델 대응), 미지원 서버면 Chat Completions 로 자동 전환', async () => {
  await api('PUT', '/api/settings/model', { model: 'gpt-6-luna' });
  let r = await api('POST', '/api/chat', { message: '내일 오후 3시에 회의 등록해줘', scope: { type: 'today' } });
  assert.equal(lastPath, '/v1/responses');
  assert.equal(lastBody.store, false);
  assert.equal(lastBody.reasoning, undefined);
  assert.equal(lastBody.tools[0].type, 'function');
  assert.equal(lastBody.tools[0].name, 'propose_event');
  assert.equal(r.data.messages.at(-1).proposals[0].payload.start_time, '15:00');

  await api('PUT', '/api/settings/model', { model: 'legacy-only' });
  r = await api('POST', '/api/chat', { message: '내일 오후 3시에 회의 등록해줘', scope: { type: 'today' } });
  assert.equal(r.status, 200);
  assert.equal(lastPath, '/v1/chat/completions');
  assert.equal(r.data.messages.at(-1).proposals[0].kind, 'event');
  await api('PUT', '/api/settings/model', { model: '' });
});
