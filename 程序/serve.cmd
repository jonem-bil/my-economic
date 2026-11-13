@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PY=%ROOT%python\python.exe"

if not exist "%PY%" (
    echo.
    echo ============================================================
    echo   [错误] 找不到 python\python.exe
    echo ============================================================
    echo   本程序的 Python 运行时被打包在 python 子文件夹里。
    echo   如果该文件夹不存在，可能是下载不完整或被安全软件删除。
    echo ============================================================
    echo.
    pause
    exit /b 1
)

set "BOOKKEEPING_DB_PATH=%ROOT%data\bookkeeping.db"
set "BOOKKEEPING_CONFIG_PATH=%ROOT%data\config.yaml"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%backup-db.ps1" >nul 2>&1

echo.
echo ============================================================
echo   My Economic 我的经济
echo   正在启动...浏览器会自动打开 http://127.0.0.1:8765
echo   关闭这个窗口即可停止程序
echo ============================================================
echo.

start "" cmd /c "timeout /t 3 >nul ^& start http://127.0.0.1:8765"
"%PY%" "%ROOT%scripts\bookkeeping.py" dashboard --host 127.0.0.1 --port 8765
pause
