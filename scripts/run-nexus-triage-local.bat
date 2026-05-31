@echo off
REM scripts/run-nexus-triage-local.bat
REM
REM Daily Nexus triage runner for Windows Task Scheduler.
REM
REM Why this exists: GitHub Actions runner IPs are Cloudflare-blocked from
REM Nexus's CommentContainer widget endpoint (empirically 100% in our testing).
REM Polling has to run from a residential IP. This wrapper sets up env vars,
REM runs the script, and commits/pushes state changes from your machine.
REM
REM One-time setup:
REM   1. Create the dedicated venv this runner uses. Do NOT use `pip install --user`:
REM      Task Scheduler logons do not add the per-user site-packages to sys.path, so a
REM      --user curl_cffi is invisible here and every run dies with ModuleNotFoundError.
REM      From the repo root:
REM        python -m venv .nexus-triage-venv
REM        .nexus-triage-venv\Scripts\python -m pip install curl_cffi
REM   2. Open Task Scheduler -> Create Task...
REM      - Trigger: Daily at 10:00 (or whatever cadence you prefer)
REM      - Action: Start a program -> this .bat file
REM      - "Run whether user is logged on or not" if you want it to run when locked
REM   3. Test once: double-click this .bat from Explorer and check the log
REM
REM Logs to: %~dp0..\.nexus-triage-runs\YYYY-MM-DD.log

setlocal

REM --- Repo + tooling paths ---
set REPO=%~dp0..
REM Prepend the dedicated venv's Scripts so the bare `python` that nexus-triage.mjs
REM spawns resolves to it. A --user install is NOT loaded under Task Scheduler.
set VENV=%REPO%\.nexus-triage-venv
set PATH=%VENV%\Scripts;%PATH%
set LOG_DIR=%REPO%\.nexus-triage-runs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set DT=%%I
set LOG=%LOG_DIR%\%DT:~0,4%-%DT:~4,2%-%DT:~6,2%.log

REM --- Sentinel: bail if triage is disabled ---
if exist "%REPO%\scripts\nexus-triage.disabled" (
  echo [%date% %time%] sentinel present, skipping run >> "%LOG%"
  exit /b 0
)

REM --- Triage config (must match what the workflow had) ---
set NEXUSMODS_GAME_ID=8916
set NEXUSMODS_MOD_ID=856
set NEXUSMODS_OBJECT_TYPE=1
set NEXUSMODS_POSTS_THREAD_ID=16866026
set NEXUSMODS_POSTS_URL=https://www.nexusmods.com/slaythespire2/mods/856?tab=posts

REM --- GitHub token from gh CLI (must be logged in: `gh auth status`) ---
for /f "delims=" %%T in ('gh auth token 2^>nul') do set GITHUB_TOKEN=%%T
if "%GITHUB_TOKEN%"=="" (
  echo [%date% %time%] gh auth token returned empty -- run `gh auth login` first >> "%LOG%"
  exit /b 1
)

REM --- Make sure repo is on main + up to date before triaging ---
echo [%date% %time%] starting triage run >> "%LOG%"
cd /d "%REPO%" || (echo cd failed >> "%LOG%" & exit /b 1)
git checkout main >> "%LOG%" 2>&1
git pull --rebase >> "%LOG%" 2>&1

REM --- Preflight: curl_cffi must import in the venv python the script will spawn ---
python -c "import curl_cffi" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] FATAL: import curl_cffi failed for "%VENV%\Scripts\python.exe" -- recreate the venv: python -m venv .nexus-triage-venv then .nexus-triage-venv\Scripts\python -m pip install curl_cffi >> "%LOG%"
  exit /b 1
)

REM --- Run the triage script ---
node scripts\nexus-triage.mjs >> "%LOG%" 2>&1
set EXIT=%ERRORLEVEL%
echo [%date% %time%] script exited with %EXIT% >> "%LOG%"

REM --- Commit + push state changes (if any) ---
git diff --quiet scripts\nexus-triage-state.json
if errorlevel 1 (
  echo [%date% %time%] state changed, committing + pushing >> "%LOG%"
  git add scripts\nexus-triage-state.json >> "%LOG%" 2>&1
  git commit -m "chore(triage): update Nexus triage state [skip ci]" >> "%LOG%" 2>&1
  git push >> "%LOG%" 2>&1
) else (
  echo [%date% %time%] no state changes to commit >> "%LOG%"
)

echo [%date% %time%] done >> "%LOG%"

REM Propagate the triage script's exit code so a failed run shows up as a non-zero
REM LastTaskResult in Task Scheduler instead of being masked as success.
exit /b %EXIT%
