@echo off
rem Start the map-harness Web service (loopback only).
rem Usage: start.cmd [--port ^<n^>] [--no-open]
cd /d "%~dp0"
if not exist node_modules (
  echo Dependencies are missing; run install.cmd first.
  exit /b 1
)
node map\bin\map-harness.mjs web %*
