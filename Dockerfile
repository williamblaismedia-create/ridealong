# Ridealong — mode serveur en conteneur : Chrome sous Xvfb, ffmpeg (libx264), serveur MCP stdio.
#   docker build -t ridealong .
#   claude mcp add ridealong -- docker run -i --rm -p 9400:9400 -v ridealong-data:/data ridealong
# La vue live est sur http://127.0.0.1:9400 (mettre SCRY_LIVE_PUBLIC_URL si exposée ailleurs).
# GPU NVIDIA (encodage NVENC) : docker run --gpus all -e SCRY_VIDEO_ENCODER=h264_nvenc ... (runtime nvidia requis côté hôte).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget curl gnupg ca-certificates xvfb ffmpeg fonts-liberation fonts-noto-color-emoji procps \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY viewer ./viewer
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN npm i -D typescript@^5.5.0 && npx tsc -p tsconfig.json && npm remove typescript
ENV SCRY_DATA_DIR=/data SCRY_CDP_URL=http://127.0.0.1:9222 SCRY_LIVE_PORT=9400 SCRY_VIDEO_ENCODER=libx264 \
    SCRY_VIEWPORT_WIDTH=1440 SCRY_VIEWPORT_HEIGHT=900 DISPLAY=:99
VOLUME ["/data"]
EXPOSE 9400
ENTRYPOINT ["bash", "/app/scripts/docker-entrypoint.sh"]
