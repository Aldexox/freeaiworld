@echo off
setlocal
cd /d "%~dp0"
echo Starting freeaiworld on http://127.0.0.1:8787 ...
start "" http://127.0.0.1:8787
python server.py --port 8787
pause
