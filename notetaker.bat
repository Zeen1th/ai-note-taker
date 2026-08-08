@echo off
cd /d "%~dp0"

rem --- If venv exists, JUST LAUNCH. No checks, no installs, nothing. ---
if exist ".venv\Scripts\pythonw.exe" (
    start "" ".venv\Scripts\pythonw.exe" desktop.py
    exit /b
)

rem --- Only reached on first run (no venv yet) ---
echo First-time setup...
where python >nul 2>nul
if errorlevel 1 (
    echo Install Python 3.12 from python.org first.
    pause
    exit /b 1
)
python -m venv .venv
".venv\Scripts\python.exe" -m pip install -r requirements-core.txt
if not exist ".env" copy .env.example .env >nul
start "" ".venv\Scripts\pythonw.exe" desktop.py
