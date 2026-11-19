@echo off
setlocal
cd /d "%~dp0"
title Twitch to YouTube Shorts

where node >nul 2>nul || (echo Node.js is not installed. See README.md, step 1. & pause & exit /b 1)
where ffprobe >nul 2>nul || (echo FFmpeg is not installed. See README.md, step 1. & pause & exit /b 1)
where docker >nul 2>nul || (echo Docker Desktop is not installed. See README.md, step 1. & pause & exit /b 1)

rem --- Gemini key (asked once, saved in openshorts\.env) ---
if not exist "openshorts\.env" (
  echo You need a free Gemini API key: https://aistudio.google.com/apikey
  set /p KEY=Paste your key here and press Enter:
  call echo GEMINI_API_KEY=%%KEY%%> "openshorts\.env"
)

rem --- Start OpenShorts (first time builds it: 15-30 min) ---
docker info >nul 2>nul || (echo Open Docker Desktop first, wait until it says "Engine running", then run this again. & pause & exit /b 1)
echo Starting OpenShorts...
pushd openshorts
docker compose up -d --build backend || (popd & echo OpenShorts failed to start. & pause & exit /b 1)
popd

rem --- Twitch link ---
set "LINK=%~1"
if "%LINK%"=="" set /p LINK=Paste the Twitch VOD link (twitch.tv/videos/...):

rem --- How many clips at once: depends on your RAM ---
for /f %%r in ('powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)"') do set RAM=%%r
set PAR=1
if %RAM% GEQ 12 set PAR=2
if %RAM% GEQ 16 set PAR=3
echo %RAM% GB RAM: making %PAR% clip(s) at a time.

rem --- Run, keeping the PC awake until it finishes ---
powershell -NoProfile -Command "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState([uint32]2147483649) | Out-Null; node make-shorts.mjs '%LINK%' --count 30 --parallel %PAR%"

echo.
echo Finished. Your shorts are in the runs folder (runs\^<video id^>\final).
pause
