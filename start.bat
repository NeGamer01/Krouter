@echo off
cd /d "%~dp0"
setlocal
if "%~1"=="" (set KROUTER_PORT=%KROUTER_PORT%) else (set KROUTER_PORT=%~1)
if "%KROUTER_PORT%"=="" set KROUTER_PORT=20128

where node >nul 2>nul
if errorlevel 1 (
  echo node.js is not installed.
  echo   install from https://nodejs.org ^(LTS^), then run this script again.
  exit /b 1
)
if not exist server.js (
  echo server.js not found next to this script - is this the krouter folder?
  exit /b 1
)

echo starting krouter on port %KROUTER_PORT%...
echo   dashboard:  http://localhost:%KROUTER_PORT%/dashboard
echo   endpoint:   http://localhost:%KROUTER_PORT%/v1
node server.js
