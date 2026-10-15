@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Node.js。請先安裝（免費）：https://nodejs.org  ，裝「LTS」版本即可。
  echo   裝好之後，再點兩下這個檔案一次。
  echo.
  start "" https://nodejs.org
  pause
  exit /b
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000/host"
node server.js
pause
