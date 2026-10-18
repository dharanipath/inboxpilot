# InboxPilot web: static React build served by nginx, which also proxies /api to the gateway
# (same origin: cookies, SSE and the gateway's Origin check work unchanged). Context: apps/web

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts tailwind.config.ts postcss.config.js ./
COPY public ./public
COPY src ./src
RUN npx vite build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
