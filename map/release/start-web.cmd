@echo off
rem Verify and start the source-free Map Harness Web service.
setlocal
set "SCRIPT=%~dp0start-web.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
