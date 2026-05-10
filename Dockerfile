FROM node:20-slim

# Install Chromium + all required libs for Puppeteer
RUN apt-get update && apt-get install -y \
  chromium fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libxss1 \
  libxtst6 wget ca-certificates python3 make g++ \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Create data directory and give the node user full ownership
RUN mkdir -p /app/data && chown -R node:node /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
