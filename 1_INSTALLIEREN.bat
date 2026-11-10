@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Meme-Coin-Trader - Installation
echo ==============================================
echo    Meme-Coin-Trader - Installation
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto keinnode

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 goto nodealt
echo [OK] Node.js gefunden, Version:
node -v
echo.

echo Installiere Bibliotheken, bitte warten...
call npm install --no-fund --no-audit
if errorlevel 1 goto fehler
echo [OK] Bibliotheken installiert.
echo.

if exist ".env" goto envda
copy ".env.example" ".env" >nul
echo [OK] Einstellungsdatei .env angelegt - Papiermodus, kein echtes Geld.
goto envok
:envda
echo [OK] Einstellungsdatei .env ist bereits vorhanden und bleibt unveraendert.
:envok
echo.

echo Selbsttest laeuft...
call npm test >nul 2>nul
if errorlevel 1 goto testfehler
echo [OK] Selbsttest bestanden.
echo.
echo ==============================================
echo  FERTIG. Naechster Schritt:
echo  Doppelklick auf 3_BOT_STARTEN.bat
echo  Der Bot startet im PAPIERMODUS - ohne echtes Geld.
echo ==============================================
echo.
pause
exit /b 0

:keinnode
echo [FEHLER] Node.js ist nicht installiert.
echo.
echo 1. Gleich oeffnet sich nodejs.org - dort die Version "LTS" herunterladen.
echo 2. Installieren, dabei immer "Weiter" klicken.
echo 3. Danach DIESE Datei erneut doppelklicken.
echo.
pause
start "" "https://nodejs.org"
exit /b 1

:nodealt
echo [FEHLER] Deine Node.js-Version ist zu alt. Benoetigt wird Version 22 oder neuer.
echo Bitte die aktuelle LTS-Version von nodejs.org installieren und diese Datei erneut starten.
echo.
pause
start "" "https://nodejs.org"
exit /b 1

:fehler
echo.
echo [FEHLER] Die Installation ist fehlgeschlagen. Bitte Internetverbindung pruefen
echo und diese Datei erneut starten. Bleibt der Fehler, die Meldung oben an Claude schicken.
echo.
pause
exit /b 1

:testfehler
echo [WARNUNG] Der Selbsttest ist fehlgeschlagen. Bitte "npm test" ausfuehren
echo und die Ausgabe an Claude schicken. Den Bot so NICHT live benutzen.
echo.
pause
exit /b 1
