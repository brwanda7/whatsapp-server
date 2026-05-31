FROM node:20-bullseye

# Install Chromium + dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy dependency files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Tell Puppeteer where Chromium is
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Render exposes PORT dynamically
ENV PORT=3001

EXPOSE 3001

# Start app
CMD ["node", "index.js"]