@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0RUN-BOTH-CAMPAIGN-ANALYTICS.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo One or more analytics runs failed. Exit code: %EXIT_CODE%
) else (
  echo Analytics completed for both campaigns.
)
echo.
pause
exit /b %EXIT_CODE%
