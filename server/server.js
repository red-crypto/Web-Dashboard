// 개인 대시보드 서버. 외부 패키지 없이 Node 내장 모듈만 사용한다.
// 실행: npm start  (또는 node server/server.js)

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// .env 파일이 있으면 읽는다 (OPENAI_API_KEY 등). 이미 설정된 환경변수가 우선.
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const db = require('./db');
const ai = require('./ai');
const time = require('./time');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // 기본은 내 컴퓨터에서만 접속 가능
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- 라우팅 ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const notFound = () => { throw new HttpError(404, '항목을 찾을 수 없습니다.'); };
const orNotFound = (v) => (v ? v : notFound());

route('GET', '/api/settings', () => ({ timezone: time.TZ, today: time.today(), ai: ai.status(), dbPath: db.DB_PATH }));
route('POST', '/api/settings/test', () => ai.testConnection());

route('GET', '/api/home', () => db.home());
route('GET', '/api/calendar', ({ query }) => db.calendar(query.get('month')));

route('GET', '/api/projects', ({ query }) => db.listProjects({ status: query.get('status') || undefined }));
route('POST', '/api/projects', ({ body }) => db.createProject(body));
route('GET', '/api/projects/:id', ({ params }) => orNotFound(db.getProject(params.id)));
route('PUT', '/api/projects/:id', ({ params, body }) => orNotFound(db.updateProject(params.id, body)));
route('DELETE', '/api/projects/:id', ({ params }) => ({ ok: db.deleteProject(params.id) || notFound() }));

route('GET', '/api/todos', ({ query }) => db.listTodos({
  filter: query.get('filter') || 'all',
  projectId: query.get('project') ? Number(query.get('project')) : undefined,
  date: query.get('date') || undefined,
}));
route('POST', '/api/todos', ({ body }) => db.createTodo(body));
route('PUT', '/api/todos/:id', ({ params, body }) => orNotFound(db.updateTodo(params.id, body)));
route('DELETE', '/api/todos/:id', ({ params }) => ({ ok: db.deleteTodo(params.id) || notFound() }));

route('GET', '/api/events', ({ query }) => db.listEvents({ from: query.get('from') || undefined, to: query.get('to') || undefined }));
route('POST', '/api/events', ({ body }) => db.createEvent(body));
route('PUT', '/api/events/:id', ({ params, body }) => orNotFound(db.updateEvent(params.id, body)));
route('DELETE', '/api/events/:id', ({ params }) => ({ ok: db.deleteEvent(params.id) || notFound() }));

route('GET', '/api/conversations', () => db.listConversations());
route('GET', '/api/conversations/:id', ({ params }) => orNotFound(db.getConversation(params.id)));
route('DELETE', '/api/conversations/:id', ({ params }) => ({ ok: db.deleteConversation(params.id) || notFound() }));
route('POST', '/api/chat', ({ body }) => ai.chat(body));
route('POST', '/api/proposals/:id/apply', ({ params }) => orNotFound(db.applyProposal(params.id)));
route('POST', '/api/proposals/:id/dismiss', ({ params }) => orNotFound(db.dismissProposal(params.id)));

// ---------- 공통 처리 ----------
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new HttpError(413, '요청이 너무 큽니다.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(new HttpError(400, 'JSON 형식이 잘못되었습니다.')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400); return res.end('Bad request'); // 잘못된 %XX 인코딩
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 알 수 없는 경로는 SPA 첫 화면으로
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'] });
        res.end(e2 ? 'Not found' : html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: '서버 오류가 발생했습니다.' }); else res.end();
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: '없는 API 입니다.' });
  const m = url.pathname.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler({ params, query: url.searchParams, body });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e instanceof db.ValidationError) return send(res, 400, { error: e.message });
    if (e instanceof ai.AiError) return send(res, 502, { error: e.message, retryable: true });
    console.error(e);
    send(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
}

server.listen(PORT, HOST, () => {
  const s = ai.status();
  console.log(`대시보드 실행 중: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  시간대: ${time.TZ} (오늘 ${time.today()})`);
  console.log(`  DB: ${db.DB_PATH}`);
  console.log(`  OpenAI: ${s.keyConfigured ? '키 설정됨, 모델 ' + s.model : '키 없음 (AI 채팅 비활성, 나머지 기능은 사용 가능)'}`);
});
