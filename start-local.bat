@echo off
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8000"
python -m http.server 8000
pause
