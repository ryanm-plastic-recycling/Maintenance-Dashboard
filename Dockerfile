FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chmod +x cron.sh
RUN apt-get update && apt-get install -y cron && rm -rf /var/lib/apt/lists/*
# Schedule ETL at midnight
RUN echo "0 0 * * * /app/cron.sh" > /etc/cron.d/etl-cron \
    && chmod 0644 /etc/cron.d/etl-cron \
    && crontab /etc/cron.d/etl-cron
CMD ["cron", "-f"]
