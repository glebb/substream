FROM --platform=linux/amd64 local/chromium47:352221

RUN apt-get update && apt-get install -y --no-install-recommends x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*

COPY start.sh /usr/local/bin/start-chromium47
COPY provider-preview.py /usr/local/bin/provider-preview.py
RUN chmod +x /usr/local/bin/start-chromium47 /usr/local/bin/provider-preview.py
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/start-chromium47"]
