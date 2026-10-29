@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto node_missing
node -e "if(process.versions.node.split('.')[0] !== '24')process.exit(1)"
if errorlevel 1 goto node_missing
call npm ci --no-fund
if errorlevel 1 goto failed
call npm run init:env
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
call npm run doctor
if errorlevel 1 goto ffmpeg_missing
echo Installation complete. Fill .env, then run register.bat and start.bat.
pause
exit /b 0
:node_missing
echo Install Node.js 24 LTS x64 from https://nodejs.org/ and reopen this window.
pause
exit /b 1
:ffmpeg_missing
echo Install FFmpeg and add it to PATH, or set FFMPEG_PATH in .env.
echo Example: winget install --id Gyan.FFmpeg -e
:failed
echo Installation failed. See the error above.
pause
exit /b 1
