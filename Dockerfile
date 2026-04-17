FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY feeds.json ./
COPY public/ ./public/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
