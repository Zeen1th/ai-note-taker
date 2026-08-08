@echo off
rem ============================================================
rem  note·taker — one-click install + launch
rem
rem  First run:  creates venv, installs deps, creates .env, launches.
rem  Later runs: skips install, launches instantly.
rem  ============================================================
cd /d "%~dp0"

rem --- Check Python is installed ---
where python >nul 2>nul
if errorlevel 1 (
    echo Python not found. Install Python 3.10-3.12 from python.org
    echo and tick "Add Python to PATH", then run this again.
    pause
    exit /b 1
)

rem --- Create venv if it doesn't exist ---
if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
)

rem --- Install deps if not yet installed (checks for fastapi as a sentinel) ---
".venv\Scripts\python.exe" -c "import fastapi" >nul 2>nul
if errorlevel 1 (
    echo Installing dependencies ^(first run only — takes a minute^)...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>nul
    ".venv\Scripts\python.exe" -m pip install -r requirements-core.txt >nul 2>nul
    if errorlevel 1 (
        echo Dependency install failed. Check your internet connection.
        pause
        exit /b 1
    )
)

rem --- Create .env from example if it doesn't exist ---
if not exist ".env" (
    copy .env.example .env >nul 2>nul
)

rem --- Launch the app (no console window) ---
start "" ".\.venv\Scripts\pythonw.exe" desktop.py
