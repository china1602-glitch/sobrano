@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node online/server.mjs %*
if errorlevel 1 pause
