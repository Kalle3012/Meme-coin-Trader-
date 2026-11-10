@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Meme-Coin-Trader - NOTVERKAUF
if not exist "node_modules\" goto nichtinstalliert
if not exist ".env" goto nichtinstalliert
echo ==============================================
echo  NOTVERKAUF: verkauft ALLE offenen Positionen des Bots sofort.
echo  WICHTIG: Das Bot-Fenster vorher mit Strg+C beenden!
echo ==============================================
echo.
set "ANTWORT="
set /p "ANTWORT=Wirklich alles verkaufen? JA eintippen und Enter druecken: "
if /i not "%ANTWORT%"=="JA" goto abbruch
call npm run -s sell-all -- --ja
echo.
pause
exit /b 0

:abbruch
echo Abgebrochen. Es wurde nichts verkauft.
pause
exit /b 0

:nichtinstalliert
echo.
echo Der Bot ist noch nicht installiert.
echo Bitte zuerst 1_INSTALLIEREN.bat doppelklicken.
echo.
pause
exit /b 1
