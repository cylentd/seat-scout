@echo off
REM enabledelayedexpansion is required: %VAR% inside an if(...) block is
REM substituted when CMD parses the block, BEFORE the set runs — so a variable
REM set and used in the same block reads as empty. !VAR! defers to run time.
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Unattended seat scan + report rebuild, for Task Scheduler (twice daily).
REM Like drops.bat it never pauses and never opens a browser; unlike
REM check-seats.bat it leaves the finished report.html in place for the (later)
REM Vercel publish step rather than opening it.
REM
REM   scan-daily.bat          tiered-freshness full scan   (the morning run)
REM   scan-daily.bat watch    cheap re-check of pair-bearers (the evening run)
REM   scan-daily.bat fresh    ignore every cache, re-fetch all
REM
REM Output is appended to data\scan.log so a scheduled run leaves a trail.

set "MODE="
if /i "%~1"=="watch" set "MODE=--watch"
if /i "%~1"=="fresh" set "MODE=--fresh"

REM The scanner talks to a real Chrome over CDP (port matches config.json).
REM If none is listening, launch one with the same persistent scan profile
REM check-seats.bat and drops.bat use, so the session and any cleared
REM challenges carry over.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
  if not exist "!CHROME!" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  start "" "!CHROME!" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\seat-scout\chrome-profile" "https://www.fandango.com"
  REM Chrome needs longer from cold than from warm; poll instead of guessing.
  for /l %%i in (1,1,20) do (
    powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 goto :chrome_ready
    timeout /t 2 /nobreak >nul
  )
  echo Chrome did not come up on :9222 - aborting. >> "data\scan.log"
  exit /b 1
)
:chrome_ready

if not exist "data" mkdir "data"
echo. >> "data\scan.log"
echo ===== %DATE% %TIME%  (mode: !MODE!) ===== >> "data\scan.log"
set NO_COLOR=1

node src\scan.mjs !MODE! >> "data\scan.log" 2>&1
if errorlevel 1 (
  echo scan failed - keeping previous report.html >> "data\scan.log"
  exit /b 1
)

REM Only rebuild the report when the scan itself succeeded, so a hard block or
REM cold-Chrome failure never replaces a good report with an empty one.
node src\report.mjs >> "data\scan.log" 2>&1
if errorlevel 1 (
  echo report build failed >> "data\scan.log"
  exit /b 1
)

REM Public signals: safe-to-publish counts (pairs, usable, sold-out) with NO
REM seat maps -> public\signals.json, the only file the hosted site ever sees.
node src\signals.mjs >> "data\scan.log" 2>&1
if errorlevel 1 (
  echo signals export failed >> "data\scan.log"
  exit /b 1
)

REM Publish: uploads only public\ + api\ + vercel.json (.vercelignore allow-list)
REM to https://seat-scout-tan.vercel.app. Uses the CLI's saved login; a failure
REM here is logged but does not fail the run (the scan and report are already done).
call npx vercel --prod --yes >> "data\scan.log" 2>&1
if errorlevel 1 echo vercel publish failed >> "data\scan.log"

echo scan + report + publish OK >> "data\scan.log"
exit /b 0
