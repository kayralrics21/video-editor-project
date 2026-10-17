@echo off
title kayralrics.com - video
echo Starting kayralrics.com - video  ^|  Credit: kayralrics.net
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto :end
)
echo Python 3 is required. Install it from https://www.python.org/downloads/ and try again.
pause
:end
