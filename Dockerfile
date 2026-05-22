FROM oven/bun:1-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY package.json ./
RUN bun install --production

COPY src ./src
COPY public ./public
COPY README.md ./

RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["bun", "src/server.js"]
