@echo off
rem Launch the AI Note-Taker desktop app (chromeless app window + tray, no console).
cd /d "%~dp0"
start "" ".\.venv\Scripts\pythonw.exe" desktop.py
