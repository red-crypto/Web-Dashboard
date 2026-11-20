@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

echo My Dashboard 바탕화면 아이콘을 만듭니다.
echo.
choice /c YN /m "윈도우를 켤 때 대시보드 서버를 자동으로 실행할까요"
if errorlevel 2 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcuts.ps1" -Mode install
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcuts.ps1" -Mode install -Autostart
)
if errorlevel 1 (
  echo [오류] 바로가기를 만들지 못했습니다.
  pause
  exit /b 1
)

echo.
echo 완료! 바탕화면의 "My Dashboard" 아이콘을 더블클릭하면 대시보드가 열립니다.
echo 서버 끄기: 대시보드 [설정] 화면의 [서버 종료] 버튼
echo 지우기: 이 폴더의 uninstall.bat 실행
echo.
choice /c YN /m "지금 대시보드를 열까요"
if errorlevel 2 exit /b 0
wscript.exe "%~dp0start-hidden.vbs" --open
