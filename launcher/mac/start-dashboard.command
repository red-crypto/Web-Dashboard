#!/bin/bash
# 더블클릭하면 대시보드 서버를 백그라운드로 켜고 브라우저를 엽니다.
# 이미 켜져 있으면 브라우저만 엽니다. 이 터미널 창은 닫아도 됩니다.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[오류] Node.js 가 설치되어 있지 않습니다."
  echo "https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  read -r -n 1 -p "아무 키나 누르면 닫힙니다..."
  exit 1
fi

mkdir -p data
nohup node --disable-warning=ExperimentalWarning server/server.js --open >> data/server.log 2>&1 &
sleep 1
echo "대시보드를 열었습니다: http://localhost:${PORT:-3000}"
echo "이 창은 닫아도 됩니다. 서버 끄기: 대시보드 [설정] > [서버 종료]"
