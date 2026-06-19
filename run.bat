@echo off
cd /d "%~dp0"
.\.venv\Scripts\python.exe -m uvicorn app:app --reload