// 날짜/시간 도우미. 모든 "오늘" 계산은 설정된 시간대(기본 Asia/Seoul) 기준이다.
// 날짜는 'YYYY-MM-DD', 시간은 'HH:MM' 문자열로 다룬다 (DB에도 그대로 저장).

const TZ = process.env.APP_TIMEZONE || 'Asia/Seoul';

function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return p;
}

function today() {
  const p = partsIn(new Date(), TZ);
  return `${p.year}-${p.month}-${p.day}`;
}

function nowTime() {
  const p = partsIn(new Date(), TZ);
  return `${p.hour}:${p.minute}`;
}

// 'YYYY-MM-DD' + n일
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// 0=일 ... 6=토
function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 이번 주(월~일) 범위
function weekRange(dateStr) {
  const wd = weekday(dateStr);
  const mondayOffset = wd === 0 ? -6 : 1 - wd;
  const start = addDays(dateStr, mondayOffset);
  return { start, end: addDays(start, 6) };
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// 설정 시간대에서 'YYYY-MM-DD' 00:00 이 되는 실제 시각 (Date)
function startOfDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  // 해당 시각을 시간대로 바꿨을 때의 차이만큼 보정 (두 번이면 서머타임 경계도 맞춰진다)
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(t), TZ);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    t -= asUtc - Date.UTC(y, m - 1, d);
  }
  return new Date(t);
}

module.exports = { startOfDay, TZ, today, nowTime, addDays, weekday, weekRange, isDate, isTime, WEEKDAY_KO };
