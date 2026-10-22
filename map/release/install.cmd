@echo off
rem Install map-harness dependencies (prebuilt release; no compilation).
rem Usage: install.cmd [--registry ^<url^>]
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.19+ or 24+ is required: https://nodejs.org  ^(mirror: https://npmmirror.com/mirrors/node/^)
  exit /b 1
)
node map\bin\setup.mjs %*
