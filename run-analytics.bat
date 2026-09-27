@echo off
setlocal

set "REPOSITORY_DIRECTORY=%~dp0"

if "%~1"=="" (
  echo Usage:
  echo   run-analytics.bat "C:\path\to\run-or-campaign-directory"
  echo.
  echo The directory may directly contain website directories, or it may contain
  echo immediate child run directories whose analytics should be combined.
  exit /b 2
)

set "RUN_DIRECTORY=%~f1"

if not exist "%RUN_DIRECTORY%\" (
  echo Analytics run directory does not exist:
  echo   %RUN_DIRECTORY%
  exit /b 2
)

pushd "%REPOSITORY_DIRECTORY%"
if errorlevel 1 (
  echo Could not enter the repository directory:
  echo   %REPOSITORY_DIRECTORY%
  exit /b 1
)

echo Running analytics for run or campaign:
echo   %RUN_DIRECTORY%
echo.

call npm run analyze -- "%RUN_DIRECTORY%"
set "ANALYTICS_EXIT_CODE=%ERRORLEVEL%"

popd

if not "%ANALYTICS_EXIT_CODE%"=="0" (
  echo.
  echo Analytics failed with exit code %ANALYTICS_EXIT_CODE%.
  exit /b %ANALYTICS_EXIT_CODE%
)

echo.
echo Analytics completed successfully.
echo Latest output:
echo   %RUN_DIRECTORY%\analytics\latest

exit /b 0
