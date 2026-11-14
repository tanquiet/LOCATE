@echo off
REM Locate demo launcher: starts both local servers and opens the app.
REM Double-click this file. Close the two server windows to stop.
setlocal
cd /d "%~dp0app"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3 from python.org and tick "Add to PATH".
  pause
  exit /b 1
)

echo Starting the Locate app server      (http://localhost:8000) ...
start "Locate app server - keep open" cmd /k python -m http.server 8000

if exist "%~dp0certs\cert.pem" (
  echo Starting the phone tracker server  (https, port 8443) ...
  start "Locate phone tracker server - keep open" cmd /k python serve_https.py
) else (
  echo No certs\cert.pem found - skipping the https server for the phone tracker.
  echo See README, "Phone as the tracker", to create the certificate.
)

timeout /t 2 /nobreak >nul
start "" "http://localhost:8000/"

echo.
echo ------------------------------------------------------------------
echo  Laptop app:     http://localhost:8000
echo  Phone tracker:  https://YOUR-LAPTOP-IP:8443/tracker.html
echo                  (the exact link is printed in the tracker server window)
echo  Sign in:        admin / admin123   or   customer / customer123
echo ------------------------------------------------------------------
echo  Phone and laptop must be on the same Wi-Fi. On the phone, tap
echo  "Advanced" then "Proceed" on the certificate warning.
echo.
pause
