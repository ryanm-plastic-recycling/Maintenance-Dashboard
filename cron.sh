#!/bin/sh
# Simple cron entrypoint to run ETL
cd /app || exit 1
node etl.js >> /var/log/etl.log 2>&1
