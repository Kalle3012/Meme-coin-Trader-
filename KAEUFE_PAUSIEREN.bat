@echo off
chcp 65001 >nul
cd /d "%~dp0"
type nul > STOP
echo Neue Kaeufe sind PAUSIERT.
echo Der laufende Bot verwaltet bestehende Positionen weiter - Stop-Loss, Take-Profit.
echo Fortsetzen mit KAEUFE_FORTSETZEN.bat
echo.
pause
