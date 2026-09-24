FROM --platform=linux/amd64 debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip xvfb fonts-liberation libasound2 libatk1.0-0 libatk-bridge2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 libgconf-2-4 libgtk2.0-0 xauth && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/chromium && curl -fsSL 'https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/352221/chrome-linux.zip' -o /tmp/chrome.zip && unzip -q /tmp/chrome.zip -d /opt/chromium && rm /tmp/chrome.zip

CMD ["/opt/chromium/chrome-linux/chrome", "--version"]
