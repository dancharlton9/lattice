FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY feeds.json ./
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]
