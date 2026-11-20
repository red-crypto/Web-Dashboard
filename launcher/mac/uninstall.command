#!/bin/bash
PLIST="$HOME/Library/LaunchAgents/com.mydashboard.server.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
fi
rm -f "$HOME/Desktop/My Dashboard.command"
echo "바탕화면 아이콘과 자동 실행을 지웠습니다. (데이터 파일은 그대로 남아 있습니다)"
