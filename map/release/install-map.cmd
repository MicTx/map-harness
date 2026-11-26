@echo off
rem Managed per-user installer entry; forwards to this package's native manager.
setlocal
set "SCRIPT=%~dp0install-map.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
