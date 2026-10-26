@echo off
cd /d "%~dp0"
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo node.js is not installed. install from https://nodejs.org first.
  exit /b 1
)

echo installing krouter...

rem 1) add this folder to the user PATH (idempotent)
set "DIR=%CD%"
rem check if already on PATH
echo %PATH% | findstr /i /c:"%DIR%" >nul
if errorlevel 1 (
  powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH','User') + ';%DIR%', 'User')"
  echo + added %DIR% to user PATH ^(restart terminal to use krouter^)
) else (
  echo = %DIR% already on PATH
)

rem 2) register the CLI default server
node cli.js config set --url "http://127.0.0.1:%KROUTER_PORT%" >nul 2>nul

rem 3) desktop shortcut
powershell -NoProfile -Command "$s=[Environment]::GetFolderPath('Desktop'); $ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut(\"$s\krouter.lnk\"); $sc.TargetPath='node.exe'; $sc.Arguments='server.js'; $sc.WorkingDirectory='%DIR%'; $sc.Description='krouter LLM gateway'; $sc.Save()" 2>nul
if not errorlevel 1 echo + desktop shortcut created

echo.
echo done. quickstart:
echo   krouter start
echo   krouter status
echo   krouter provider add --name X --alias x --base https://api.x.com/v1 --keys k1,k2
echo   krouter tunnel start
