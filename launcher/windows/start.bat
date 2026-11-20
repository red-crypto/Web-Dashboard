@echo off
chcp 65001 >nul
rem 창을 띄운 채로 서버를 실행합니다 (로그를 직접 보고 싶을 때). 창을 닫으면 서버도 꺼집니다.
cd /d "%~dp0..\.."
where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요.
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning server\server.js --open
pause
