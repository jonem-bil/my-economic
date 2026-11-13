@echo off
chcp 65001 >nul
title My Economic 我的经济
cd /d "%~dp0"

rem ===== 首次运行：自动建目录 =====
if not exist "%~dp0data" mkdir "%~dp0data"
if not exist "%~dp0backup" mkdir "%~dp0backup"
if not exist "%~dp0data\config.yaml" if exist "%~dp0config.example.yaml" copy "%~dp0config.example.yaml" "%~dp0data\config.yaml" >nul

rem ===== 首次运行：在桌面建快捷方式（已存在则跳过）=====
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $l=Join-Path $d '我的经济.lnk'; if(-not(Test-Path $l)){ try { $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath='%~dp0开始使用.cmd'; $s.WorkingDirectory='%~dp0'; $s.Description='My Economic 我的经济'; $s.Save(); Write-Host '[提示] 已在桌面创建快捷方式：我的经济' } catch {} }" 2>nul

call "%~dp0serve.cmd"
