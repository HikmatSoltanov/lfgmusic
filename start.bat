@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if not exist .env goto missing
call npm run build
if errorlevel 1 goto failed
call npm start
if errorlevel 1 goto failed
exit /b 0
:missing
echo Run install.bat and fill .env first.
:failed
echo Bot did not start or stopped with an error. See output above.
pause
exit /b 1
