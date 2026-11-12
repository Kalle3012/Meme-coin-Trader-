@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Meme-Coin-Trader - Fruehphasen-Radar
if not exist "node_modules\" goto nichtinstalliert
if not exist ".env" goto nichtinstalliert
echo Zeigt 30 Minuten lang neue Coins und ihren Potenzial-Score. Kauft NICHTS.
echo Beenden mit Strg+C.
echo.
call npm run -s fruehphase -- 30
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
