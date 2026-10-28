@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>&1
if not errorlevel 1 (
    py -3 -B server.py %*
) else (
    where python >nul 2>&1
    if errorlevel 1 (
        echo Python не найден. Установите Python 3 с python.org.
        pause
        exit /b 1
    )
    python -B server.py %*
)
pause
