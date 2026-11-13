@echo off
setlocal
chcp 65001 >nul
set "SKILLROOT=%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
rem Local-only paths (optional, excluded by .gitignore)
if exist "%SKILLROOT%local-paths.cmd" call "%SKILLROOT%local-paths.cmd"
if not defined BOOKKEEPING_DB_PATH set "BOOKKEEPING_DB_PATH=%SKILLROOT%data\bookkeeping.db"
if not defined BOOKKEEPING_CONFIG_PATH set "BOOKKEEPING_CONFIG_PATH=%SKILLROOT%scripts\config.yaml"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SKILLROOT%backup-db.ps1" >nul 2>&1
"%PY%" "%SKILLROOT%scripts\bookkeeping.py" dashboard --host 127.0.0.1 --port 8765
