// 자정을 넘긴 타이머 기록이 날짜별로 나뉘어 계산되는지 (DB를 메모리에 띄워 직접 검증)
process.env.DB_PATH = ':memory:';
process.env.APP_TIMEZONE = 'Asia/Seoul';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const time = require('../server/time');
const focus = require('../server/focus');

test('자정을 넘긴 타이머는 날짜별로 나눠서 센다', () => {
  // 서울 기준 2026-01-10 23:50 ~ 2026-01-11 00:10
  const start = new Date(time.startOfDay('2026-01-11').getTime() - 10 * 60000).toISOString();
  const end = new Date(time.startOfDay('2026-01-11').getTime() + 10 * 60000).toISOString();
  db.run('INSERT INTO time_logs (title, date, started_at, ended_at, minutes) VALUES (?, ?, ?, ?, ?)', '야간 작업', '2026-01-10', start, end, 20);
  db.run('INSERT INTO time_logs (title, date, minutes) VALUES (?, ?, ?)', '직접 기록', '2026-01-11', 5);
  assert.equal(focus.trackedMinutes('2026-01-10'), 10);
  assert.equal(focus.trackedMinutes('2026-01-11'), 15);
});
