# Maintenance Dashboard

This project provides a simple dashboard that displays data from the Limble CMMS
API. It is built with Node and Express and serves a single-page dashboard that
shows a live list of work orders for a configured location.

## Features

- **Live work order table** – the dashboard pulls the latest tasks from Limble
  whenever the page is loaded.
- **Asset name mapping** – asset IDs are converted to human readable names by
  first querying the `/api/assets` endpoint.
- **Status and priority decoding** – `public/mappings.json` translates status,
  type, priority, team and location IDs into meaningful text.
- **Refresh button** – quickly reload the data without restarting the server.
- **REST endpoints** – the server exposes several endpoints used by the
  frontend:
  - `/api/assets` fetches asset information.
  - `/api/task` returns recent open work orders.
  - `/api/taskpm` returns open preventative maintenance tasks.
  - `/api/hours` returns labor hour data.
  These endpoints proxy requests to Limble using credentials provided through
  environment variables.

The dashboard itself lives in `public/index.html` and is styled with basic CSS.
JavaScript in the page fetches data from the endpoints above and renders it in a
table.

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
3. (Optional) Adjust `PORT` and `LOCAL_IP` in `.env` to change where the server listens. Set `LOCAL_IP` to `192.168.48.255` to host on that address. Set `ADMIN_PASSWORD` for accessing the admin page.
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
The admin interface is available at `http://<LOCAL_IP>:<PORT>/admin`.
