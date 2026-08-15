FROM node:20-alpine

WORKDIR /app

# sharp builds against libvips. build-base and python3 are only needed when a
# prebuilt binary is unavailable for the platform.
RUN apk add --no-cache vips-dev build-base python3

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# .dockerignore keeps .wa-session out of the image. Baking a session into a
# layer would ship WhatsApp credentials into the registry and, worse, restore a
# stale session over a healthy one on every redeploy.
COPY . .

# The live session lives on a mounted volume so it survives redeploys.
# Without this the container filesystem is replaced on each release and the
# operator has to re-scan the QR every time — the pairing is the one piece of
# state that cannot be regenerated automatically.
ENV WA_SESSION_DIR=/data/.wa-session
VOLUME ["/data"]

EXPOSE 8081

# /health is intentionally unauthenticated and returns a group count, never
# group names, so it is safe for an orchestrator to poll.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD wget -qO- http://localhost:8081/health || exit 1

CMD ["node", "whatsapp-worker.mjs"]
