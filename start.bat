@echo off
setlocal enabledelayedexpansion
title Cheat Clip PRO

:: Change directory safely to current folder (handling spaces in path)
cd /d "%~dp0"

echo ===================================================
echo   Starting Cheat Clip PRO (Space & PATH Resilient)
echo ===================================================

:: If local venv exists, prepend its Scripts directory to PATH
if exist "%~dp0venv\Scripts" (
    set "PATH=%~dp0venv\Scripts;%PATH%"
) else if exist "%~dp0.venv\Scripts" (
    set "PATH=%~dp0.venv\Scripts;%PATH%"
)

:: Verify Node.js and NPM
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm is not found in your system PATH!
    echo Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

:: Run the application
npm run dev
if %errorlevel% neq 0 (
    echo.
    echo [WARNING] Application stopped with error code %errorlevel%.
    pause
)
