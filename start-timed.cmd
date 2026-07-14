@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\startup-timing.ps1" %*
exit /b %ERRORLEVEL%
