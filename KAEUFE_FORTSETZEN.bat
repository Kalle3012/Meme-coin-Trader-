@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist STOP del STOP
echo Neue Kaeufe sind wieder ERLAUBT.
echo.
pause
