@echo off
rem ============================================================
rem  note·taker — first-time setup (no AI required)
rem  Just double-click this file. It creates the venv, installs
rem  the core dependencies, and tells you what to do next.
rem ============================================================
cd /d "%~dp0"
echo.
echo  === note.taker setup ===
echo.

rem --- 1. Check Python is installed ---
where python >nul 2>nul
if errorlevel 1 (
    echo  [!] Python not found. Install Python 3.10-3.12 from python.org
    echo      and tick "Add Python to PATH", then run this again.
    echo.
    pause
    exit /b 1
)

rem --- 2. Create the virtual environment if it doesn't exist ---
if not exist ".venv\Scripts\python.exe" (
    echo  [1/3] Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo  [!] Could not create virtual environment.
        pause
        exit /b 1
    )
) else (
    echo  [1/3] Virtual environment already exists.
)

rem --- 3. Install core dependencies (notes + boards, no AI) ---
echo  [2/3] Installing core dependencies (this takes a minute)...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>nul
".venv\Scripts\python.exe" -m pip install -r requirements-core.txt
if errorlevel 1 (
    echo  [!] Dependency install failed. Check your internet connection.
    pause
    exit /b 1
)

rem --- 4. Create .env from the example if it doesn't exist ---
if not exist ".env" (
    echo  [3/3] Creating .env config file...
    copy .env.example .env >nul
) else (
    echo  [3/3] .env already exists.
)

echo.
echo  ========================================
echo  Setup complete!
echo.
echo  To start the app:  double-click  notetaker.bat
echo  Dev mode (browser): double-click  run.bat
echo.
echo  Notes, boards, and library work right now.
echo  For AI features (transcription, notes, chat):
echo    1. Install Ollama from ollama.com
echo    2. Run:  ollama pull qwen3:14b
echo    3. pip install -r requirements.txt  (adds WhisperX)
echo  ========================================
echo.
pause
