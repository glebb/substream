#!/bin/sh
set -eu

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 1
x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
python3 /usr/local/bin/provider-preview.py >/tmp/provider-preview.log 2>&1 &
sleep 1

exec /opt/chromium/chrome-linux/chrome \
  --no-sandbox \
  --user-data-dir=/tmp/chromium47-profile \
  --disable-gpu \
  --disable-dev-shm-usage \
  --window-size=1920,1080 \
  --kiosk \
  http://127.0.0.1:4173/
