@echo off
setlocal

set "RUN_DIRECTORY=C:\Users\olegl\Documents\PW\run_results\2_Campaigns\Campaign_ALUMNI\runs\rerun_2026-08-11_00-16-26"
set "ANALYTICS_LAUNCHER=%~dp0..\..\run-analytics.bat"

call "%ANALYTICS_LAUNCHER%" "%RUN_DIRECTORY%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Analytics failed. Exit code: %EXIT_CODE%
) else (
  echo Analytics output:
  echo   %RUN_DIRECTORY%\analytics\latest
)
echo.
pause
exit /b %EXIT_CODE%
