@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
call npm run register
if errorlevel 1 goto failed
echo Commands registered.
pause
exit /b 0
:failed
echo Registration failed. Check .env and bot invitation.
pause
exit /b 1
