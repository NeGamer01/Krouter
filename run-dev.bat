@echo off
cd /d "%~dp0"
if "%KROUTER_PORT%"=="" set KROUTER_PORT=20129
node server.js
