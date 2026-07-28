@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   다듬 스튜디오 맞춤법 검사기
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.
    echo.
    pause
    exit /b 1
)

echo 검사 서버를 시작합니다...
start "다듬 스튜디오 서버" /min cmd /c "node server.js"

echo 서버가 준비될 때까지 잠시 기다립니다...
timeout /t 2 /nobreak >nul

echo 브라우저를 엽니다: http://localhost:3787
start "" "http://localhost:3787"

echo.
echo 완료되었습니다.
echo 사용이 끝나면 최소화된 "다듬 스튜디오 서버" 창을 닫아 주세요.
echo.
timeout /t 3 /nobreak >nul
