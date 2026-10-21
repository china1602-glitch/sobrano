@echo off
cd /d "%~dp0"
py -B server.py
if errorlevel 1 pause
