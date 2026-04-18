FROM node:22-alpine

# better-sqlite3 ships prebuilt binaries for alpine-x64/arm64, but keep
# build-base + python3 around in case npm falls back to a native compile.
RUN apk add --no-cache curl python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js db.js cluster.js extract.js ai.js ./
COPY feeds.json ./
COPY public/ ./public/

RUN mkdir -p /app/data

ENV DB_PATH=/app/data/lattice.db

EXPOSE 3000

CMD ["node", "server.js"]
