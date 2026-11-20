@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcuts.ps1" -Mode uninstall
echo 바탕화면 아이콘과 자동 실행을 지웠습니다. (데이터 파일은 그대로 남아 있습니다)
pause
