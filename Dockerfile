FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js db.js cluster.js extract.js ai.js ./
COPY feeds.json ./
COPY public/ ./public/
COPY assets/ ./assets/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
