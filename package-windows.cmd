@echo off
cd /d "%~dp0"
powershell -NoProfile -File "%~dp0scripts\package-windows.ps1" %*
if errorlevel 1 (pause & exit /b 1)
pause
