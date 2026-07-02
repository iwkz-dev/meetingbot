FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3010
ENV DATA_DIR=/app/data

RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY src ./src
COPY .env.example ./
COPY tsconfig.json ./
COPY README.md ./
COPY docs ./docs
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const http=require('http'); const port=process.env.PORT || 3010; http.get({host:'127.0.0.1', port, path:'/health'}, (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

USER node
CMD ["pnpm", "start"]
