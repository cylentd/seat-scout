@echo off
REM enabledelayedexpansion is required: %VAR% inside an if(...) block is
REM substituted when CMD parses the block, BEFORE the set runs — so a variable
REM set and used in the same block reads as empty. !VAR! defers to run time.
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Drop watch: has the run been extended, or have sold-out seats come back?
REM Designed to be run unattended by Task Scheduler (see README), so unlike
REM check-seats.bat it never pauses and never opens a browser window.
REM
REM   drops.bat            check every target in watchlist.json
REM   drops.bat -v         same, printing every probed date
REM
REM Output is appended to data\drops.log so a scheduled run leaves a trail.

set "ARGS=%*"

REM The watcher talks to a real Chrome over CDP (port matches watchlist.json).
REM If none is listening, launch one with the same persistent scan profile
REM check-seats.bat uses, so the session and any cleared challenges carry over.
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
  echo Chrome did not come up on :9222 - aborting. >> "data\drops.log"
  exit /b 1
)
:chrome_ready

if not exist "data" mkdir "data"
echo. >> "data\drops.log"
echo ===== %DATE% %TIME% ===== >> "data\drops.log"
set NO_COLOR=1
node src\drop-watch.mjs %ARGS% >> "data\drops.log" 2>&1
exit /b %errorlevel%
