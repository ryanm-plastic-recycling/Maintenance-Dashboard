# Maintenance Dashboard

This project provides a simple dashboard that displays data from Limble CMMS.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and provide your Limble API credentials:
   ```bash
   cp .env.example .env
   # edit .env and fill CLIENT_ID and CLIENT_SECRET
   ```
3. (Optional) Adjust `PORT` and `LOCAL_IP` in `.env` to change where the server listens. Set `LOCAL_IP` to `192.168.48.255` to host on that address.
4. Start the server:
   ```bash
   npm start
   ```

## Development

- Lint code with:
  ```bash
  npm run lint
  ```
- Run tests with:
  ```bash
  npm test
  ```

The dashboard will be available at `http://<LOCAL_IP>:<PORT>/` when running.
