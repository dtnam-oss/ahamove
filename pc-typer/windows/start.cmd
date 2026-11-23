@echo off
rem pc-typer: double-click to start. Runs pc-typer.ps1 with the built-in Windows PowerShell (nothing to install).
rem Run straight from inside the zip, Windows copies only this file to a temp folder: say how to extract first.
if not exist "%~dp0pc-typer.ps1" (
  echo.
  echo CHUA GIAI NEN FILE ZIP - pc-typer khong chay duoc tu ben trong file zip.
  echo   1. Dong cua so nay.
  echo   2. Bam chuot phai vao file pc-typer.zip, chon Extract All ^(Giai nen tat ca^), bam Extract.
  echo   3. Mo thu muc vua giai nen, vao thu muc windows, bam dup start.cmd.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pc-typer.ps1"
echo.
echo pc-typer da dung. Bam phim bat ky de dong cua so.
pause >nul
