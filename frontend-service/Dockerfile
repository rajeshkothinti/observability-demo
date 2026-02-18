FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js db.js ./
COPY public ./public

EXPOSE 3001

ENV PORT=3001
CMD ["node", "server.js"]
