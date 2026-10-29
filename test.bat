@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
call npm run check
if errorlevel 1 goto failed
call npm test
if errorlevel 1 goto failed
echo All checks passed.
pause
exit /b 0
:failed
echo Checks failed. See output above.
pause
exit /b 1
