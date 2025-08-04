@echo off
REM -------------------------------------------------
REM monitor-dashboard.bat
REM Opens three windows: status, logs, and live monitor
REM -------------------------------------------------

echo %DATE% %TIME%: Launching PM2 monitors >> "C:\Users\ryanm\OneDrive - Plastic Recycling\Documents\GitHub\Maintenance-Dashboard\log.txt"

REM Change to your project directory
cd /d "C:\Users\ryanm\OneDrive - Plastic Recycling\Documents\GitHub\Maintenance-Dashboard"

REM reload with any new .env vars
pm2 reload ecosystem.config.cjs --update-env

REM 1) PM2 process list
start cmd /k "pm2 ls"

REM 2) PM2 logs for your specific app
start cmd /k "pm2 logs maintenance-dashboard"

REM 3) PM2 live CPU/memory monitor
start cmd /k "pm2 monit"

exit
