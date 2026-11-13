@echo off
setlocal
set "APP_DIR=%~dp0"
set "URL=http://127.0.0.1:8765"

call :CHECK
if not errorlevel 1 (
  echo [Board] Already running. Opening browser...
  goto OPEN
)

echo [Board] Starting service...
start "my-economic" /min "%APP_DIR%serve.cmd"

echo [Board] Waiting for server to be ready...
for /l %%i in (1,1,30) do (
  call :CHECK
  if not errorlevel 1 goto OPEN
  ping -n 2 127.0.0.1 >nul
)

echo.
echo [ERROR] Service did not start within 30 seconds.
echo         Please screenshot this window and report it.
echo.
pause
exit /b 1

:OPEN
start "" "%URL%"
echo.
echo ============================================
echo   My Economic
echo   URL: %URL%
echo   Browser opened. You can close this window.
echo ============================================
echo.
pause
exit /b 0

:CHECK
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',8765);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
exit /b %errorlevel%
