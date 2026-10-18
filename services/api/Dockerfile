# InboxPilot API gateway: Node 22, Fastify, Prisma. Build context: repository root
# (the gateway validates agent responses against packages/contracts at runtime).

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/api/prisma ./prisma
RUN npx prisma generate
COPY services/api/tsconfig.json services/api/tsconfig.build.json ./
COPY services/api/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CONTRACTS_DIR=/app/contracts \
    PORT=4000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY packages/contracts ./contracts

USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# apply pending migrations, then serve (migrate deploy is idempotent and never resets data)
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/index.js"]
