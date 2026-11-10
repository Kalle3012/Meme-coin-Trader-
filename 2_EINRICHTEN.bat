@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Meme-Coin-Trader - Einrichtung
if not exist "node_modules\" goto nichtinstalliert
if not exist ".env" goto nichtinstalliert
call npm run -s einrichten
echo.
pause
exit /b 0

:nichtinstalliert
echo.
echo Der Bot ist noch nicht installiert.
echo Bitte zuerst 1_INSTALLIEREN.bat doppelklicken.
echo.
pause
exit /b 1
