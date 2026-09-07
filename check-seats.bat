@echo off
REM enabledelayedexpansion is required: %VAR% inside an if(...) block is
REM substituted when CMD parses the block, BEFORE the set runs — so a variable
REM set and used in the same block reads as empty. !VAR! defers to run time.
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM One-click seat check: watch-scan the pair-bearing shows, rebuild the
REM report, open it. Usage:
REM   check-seats.bat          cheap --watch check-in (default, ~2.5 min)
REM   check-seats.bat full     tiered-freshness scan of the whole window
REM   check-seats.bat fresh    ignore cache, re-fetch everything

set "MODE=--watch"
if /i "%~1"=="full"  set "MODE="
if /i "%~1"=="fresh" set "MODE=--fresh"

REM The scanner talks to a real Chrome over CDP (port matches config.json).
REM If none is listening, launch one with a persistent scan profile.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
  if not exist "!CHROME!" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  echo Launching Chrome with remote debugging on :9222 ...
  start "" "!CHROME!" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\seat-scout\chrome-profile" "https://www.fandango.com"
  timeout /t 10 /nobreak >nul
)

node src\scan.mjs %MODE%
if errorlevel 1 goto :fail

node src\report.mjs
if errorlevel 1 goto :fail

start "" "%~dp0report.html"
echo.
echo Done - report opened in your browser.
pause
exit /b 0

:fail
echo.
echo Scan or report failed - see output above. If Chrome shows a
echo "Verify you are human" prompt, click it and run this again.
pause
exit /b 1
