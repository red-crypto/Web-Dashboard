#!/bin/bash
# 바탕화면에 "My Dashboard" 실행 아이콘을 만들고, 원하면 로그인 시 자동 실행을 등록합니다.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "[오류] Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요."
  read -r -n 1 -p "아무 키나 누르면 닫힙니다..."; exit 1
fi

chmod +x "$HERE"/*.command

# 1) 바탕화면 아이콘 (더블클릭 → 서버 켜고 브라우저 열기)
LAUNCHER="$HOME/Desktop/My Dashboard.command"
cat > "$LAUNCHER" <<EOS
#!/bin/bash
exec "$HERE/start-dashboard.command"
EOS
chmod +x "$LAUNCHER"
echo "바탕화면에 'My Dashboard' 아이콘을 만들었습니다."

# 2) 로그인 시 자동 실행 (선택)
read -r -p "맥에 로그인할 때 대시보드 서버를 자동으로 켤까요? [y/N] " yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.mydashboard.server.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
  cat > "$PLIST" <<EOS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mydashboard.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$ROOT/server/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/server.log</string>
</dict>
</plist>
EOS
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load -w "$PLIST" && echo "자동 실행을 등록했습니다. 지금도 서버가 켜졌습니다."
fi

echo
echo "완료! 바탕화면의 'My Dashboard' 를 더블클릭하면 대시보드가 열립니다."
echo "지우기: 이 폴더의 uninstall.command 실행"
