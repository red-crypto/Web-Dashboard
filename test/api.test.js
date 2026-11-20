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
      const body = JSON.parse(b || '{}');
      lastPrompt = body.messages ? body.messages[0].content : '';
      const user = body.messages ? body.messages[body.messages.length - 1].content : '';
      res.setHeader('Content-Type', 'application/json');
      if (user.includes('FAIL')) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'boom' } })); }
      if (user.includes('등록')) {
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_event', arguments: JSON.stringify({ title: '프로젝트 회의', date: addDays(seoulToday(), 1), start_time: '15:00' }) } }] } }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '1. 지연된 항목부터 처리하세요.' } }] }));
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
