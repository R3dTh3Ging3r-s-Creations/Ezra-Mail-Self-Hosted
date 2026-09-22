@echo off
setlocal
title Ezra Mail Setup
cd /d "%~dp0\.."

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell could not be found.
  echo Ezra Mail setup needs Windows PowerShell to start the installer wizard.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0EzraMailSetup.ps1"
if errorlevel 1 (
  echo.
  echo Ezra Mail setup did not complete.
  echo If Windows showed a permission prompt, approve it and run this installer again.
  echo Installer log is usually in: %TEMP%\ezra-mail-install.log
  pause
  exit /b 1
)
