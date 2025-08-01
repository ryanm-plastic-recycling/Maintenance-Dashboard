// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'maintenance-dashboard',
    script: './server.js',
    cwd:  __dirname,
    watch: false,
    env: {
      NODE_ENV: 'production',
      API_BASE_URL: 'https://api.limblecmms.com:443',
      CLIENT_ID: process.env.CLIENT_ID,
      CLIENT_SECRET: process.env.CLIENT_SECRET,
      CACHE_TTL_MINUTES: process.env.CACHE_TTL_MINUTES,
      CACHE_CHECK_PERIOD_SECONDS: process.env.CACHE_CHECK_PERIOD_SECONDS,
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
      STATUS_REFRESH_ENDPOINT: process.env.STATUS_REFRESH_ENDPOINT
    }
  }]
};