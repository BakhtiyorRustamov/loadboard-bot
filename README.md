# 🚚 USPS Load Board Alert Bot

A Telegram Mini App that monitors [loadboard.apps.tie.uz](https://loadboard.apps.tie.uz/) every minute and notifies users when loads matching their preferences appear.

---

## Architecture

```
┌─────────────────────────────────────────┐
│           Telegram Mini App             │
│   (beautiful preferences dashboard)    │
└───────────────┬─────────────────────────┘
                │ WebApp data / REST API
┌───────────────▼─────────────────────────┐
│         Node.js + Express Server        │
│  ┌────────────┐  ┌────────────────────┐ │
│  │ Telegram   │  │  Cron Scheduler    │ │
│  │ Bot (poll) │  │  (every 1 minute)  │ │
│  └────────────┘  └────────┬───────────┘ │
│                           │             │
│  ┌────────────────────────▼───────────┐ │
│  │   Puppeteer Scraper                │ │
│  │   (scrapes SPA + captures API)     │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌────────────────────────────────────┐ │
│  │   SQLite Database                  │ │
│  │   users / preferences / notified   │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## Prerequisites

- **Node.js** v18+
- **Chromium** (installed automatically by Puppeteer)
- A **public HTTPS URL** (required for Telegram Mini Apps)
  - Options: [Railway](https://railway.app), [Render](https://render.com), [VPS with nginx + Let's Encrypt](https://certbot.eff.org/)

---

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the steps
3. Copy your **bot token**
4. Send `/setmenubutton` to add a menu button pointing to your app URL

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BOT_USERNAME=your_bot_username
APP_URL=https://yourdomain.com        # must be HTTPS for Telegram Mini Apps
PORT=3000
LOADBOARD_URL=https://loadboard.apps.tie.uz/
CHECK_INTERVAL_SECONDS=60
```

### 3. Install Dependencies

```bash
npm install
```

> **Note:** Puppeteer will download Chromium automatically (~170MB). This may take a minute.

### 4. Run

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

---

## Deployment

### Option A: Railway (Easiest)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables in Railway settings
4. Railway auto-assigns a public HTTPS URL

> **Important:** Set `APP_URL` to your Railway URL after deployment.

### Option B: VPS (Ubuntu)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Chromium dependencies for Puppeteer
sudo apt install -y chromium-browser ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
  libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxss1 libxtst6 lsb-release wget xdg-utils

# Clone and setup
git clone <your-repo>
cd loadboard-bot
npm install
cp .env.example .env
nano .env  # fill in your values

# Run with PM2 (process manager)
npm install -g pm2
pm2 start server.js --name loadboard-bot
pm2 save
pm2 startup
```

Setup nginx reverse proxy:
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Option C: Docker

```bash
docker build -t loadboard-bot .
docker run -d \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e APP_URL=https://yourdomain.com \
  -p 3000:3000 \
  --name loadboard-bot \
  loadboard-bot
```

---

## Register Mini App with BotFather

After deployment, register your Mini App:

1. Message [@BotFather](https://t.me/BotFather)
2. Send `/newapp`
3. Select your bot
4. Follow prompts — use your `APP_URL` as the Web App URL
5. Or, simply send the Mini App via inline button using `/start` (already configured)

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Open the Mini App to set preferences |
| `/status` | View all your active alerts |
| `/stop` | Pause all alerts |
| `/resume` | Resume all alerts |
| `/help` | Show help |

---

## How Matching Works

For each scrape cycle, the bot:

1. Fetches all loads from the load board using Puppeteer
2. Gets all active user preferences from the database
3. For each user + each preference + each load:
   - Checks pickup location (partial match, case-insensitive)
   - Checks dropoff location (partial match, case-insensitive)
   - Checks pickup date (if specified)
   - Checks load type (if specified)
4. If a match is found AND the user hasn't been notified about this load → sends Telegram notification
5. Records the notification to prevent duplicates (cleaned up after 7 days)

Empty preference fields = **match anything** (wildcard).

---

## Troubleshooting

**Bot not responding:** Check `TELEGRAM_BOT_TOKEN` in `.env`

**Mini App not opening:** Ensure `APP_URL` is an HTTPS URL (required by Telegram)

**Puppeteer crashes:** Install Chromium dependencies (see VPS setup above), or add `--no-sandbox` (already set)

**No loads found:** The loadboard site may have changed. Check logs: `pm2 logs loadboard-bot`

**Loads found but no notifications:** Users may not have preferences set, or loads may not match. Check `/status` in bot.
