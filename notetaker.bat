@echo off
rem ============================================================
rem  note·taker — one-click install + launch
rem
rem  First run:  creates venv, installs deps, creates .env, launches.
rem  Later runs: skips install, launches instantly.
rem  ============================================================
cd /d "%~dp0"

rem --- If the venv already exists, skip straight to launch ---
if exist ".venv\Scripts\pythonw.exe" goto :launch

rem --- First run: need system Python to create the venv ---
where python >nul 2>nul
if errorlevel 1 (
    echo Python not found. Install Python 3.10-3.12 from python.org
    echo and tick "Add Python to PATH", then run this again.
    pause
    exit /b 1
)

echo Creating virtual environment...
python -m venv .venv
if not exist ".venv\Scripts\python.exe" (
    echo Could not create virtual environment.
    pause
    exit /b 1
)

echo Installing dependencies ^(first run only — takes a minute^)...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>nul
".venv\Scripts\python.exe" -m pip install -r requirements-core.txt
if errorlevel 1 (
    echo Dependency install failed. Check your internet connection.
    pause
    exit /b 1
)

if not exist ".env" copy .env.example .env >nul 2>nul

:launch
rem --- Check deps are installed (in case venv exists but deps don't) ---
".venv\Scripts\python.exe" -c "import fastapi" >nul 2>nul
if errorlevel 1 (
    echo Installing dependencies ^(takes a minute^)...
    ".venv\Scripts\python.exe" -m pip install -r requirements-core.txt >nul 2>nul
)

if not exist ".env" copy .env.example .env >nul 2>nul

rem --- Launch the app ---
start "" ".\.venv\Scripts\pythonw.exe" desktop.py
