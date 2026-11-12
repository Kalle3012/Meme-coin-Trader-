@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Meme-Coin-Trader - Backtest
if not exist "node_modules\" goto nichtinstalliert
if not exist ".env" goto nichtinstalliert
echo Zeigt, was die Regeln des Bots mit einem bestimmten Coin gemacht haetten.
echo Die Coin-Adresse findest du auf DexScreener oder in Phantom beim Coin.
echo.
set "MINT="
set /p "MINT=Coin-Adresse einfuegen und Enter druecken: "
if "%MINT%"=="" goto leer
call npm run -s backtest -- %MINT%
echo.
pause
exit /b 0

:leer
echo Keine Adresse eingegeben.
pause
exit /b 1

:nichtinstalliert
echo.
echo Der Bot ist noch nicht installiert.
echo Bitte zuerst 1_INSTALLIEREN.bat doppelklicken.
echo.
pause
exit /b 1
