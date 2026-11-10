@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Meme-Coin-Trader - LAEUFT - Fenster offen lassen
if not exist "node_modules\" goto nichtinstalliert
if not exist ".env" goto nichtinstalliert
echo ==============================================
echo  Der Bot startet. Dieses Fenster OFFEN LASSEN.
echo  Beenden: Strg+C druecken.
echo  Fragt Windows danach "Batchvorgang abbrechen (J/N)", mit N antworten.
echo ==============================================
echo.
call npm start
echo.
echo Der Bot wurde beendet.
pause
exit /b 0

:nichtinstalliert
echo.
echo Der Bot ist noch nicht installiert.
echo Bitte zuerst 1_INSTALLIEREN.bat doppelklicken.
echo.
pause
exit /b 1
