@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>&1
if not errorlevel 1 (
    py -3 -B desktop_app.py
) else (
    where python >nul 2>&1
    if errorlevel 1 (
        echo Python не найден. Установите Python 3 с python.org с компонентом Tcl/Tk.
        pause
        exit /b 1
    )
    python -B desktop_app.py
)
if errorlevel 1 pause
