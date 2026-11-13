@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "SKILLROOT=%~dp0"
if not exist "%SKILLROOT%data" mkdir "%SKILLROOT%data"
if not defined BOOKKEEPING_DB_PATH set "BOOKKEEPING_DB_PATH=%SKILLROOT%data\bookkeeping.db"
set "PY="
if defined BK_PYTHON set "PY=%BK_PYTHON%"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY for %%I in (python.exe) do if not defined PY set "PY=%%~$PATH:I"
if not defined PY (
  echo [bk] Python not found. Install Python 3.8+ or set BK_PYTHON.
  exit /b 9009
)
"%PY%" "%SKILLROOT%scripts\bookkeeping.py" %*
exit /b %ERRORLEVEL%
