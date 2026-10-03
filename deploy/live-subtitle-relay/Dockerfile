ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/live-subtitle-relay/ services/live-subtitle-relay/
COPY src/core/ src/core/
USER node
EXPOSE 8790
CMD ["node", "services/live-subtitle-relay/main.ts"]
