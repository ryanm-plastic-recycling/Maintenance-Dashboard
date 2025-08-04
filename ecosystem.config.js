// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "maintenance-dashboard",
      script: "server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        // if you’re overriding via --update-env, you can omit these defaults
        PORT: 7601,
        API_BASE_URL: "https://api.limblecmms.com:443",
        CLIENT_ID: process.env.CLIENT_ID,
        CLIENT_SECRET: process.env.CLIENT_SECRET,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        CACHE_TTL_MINUTES: process.env.CACHE_TTL_MINUTES,
        CACHE_CHECK_PERIOD_SECONDS: process.env.CACHE_CHECK_PERIOD_SECONDS,
        STATUS_REFRESH_ENDPOINT: process.env.STATUS_REFRESH_ENDPOINT
      }
    }
  ]
};
