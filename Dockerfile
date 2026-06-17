# syntax=docker/dockerfile:1
# One image, three roles (web / worker / release-migrations) — Phase 8c.
# We keep dev deps in the runtime image on purpose: the worker runs via `tsx` and the
# release step runs `drizzle-kit migrate`, both dev deps. A standalone/prod-pruned image
# would strip them, and on Fly the web + worker processes share ONE image.
# Debian slim (glibc) over alpine (musl) for clean native bindings (@node-rs/argon2, pg).

# ---- builder: install everything + build the Next app ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# `next build` evaluates route modules (db.ts asserts DATABASE_URL exists at import) but never
# CONNECTS — every route is dynamic. A throwaway URL satisfies the assertion; the real DSN is
# injected at runtime via secrets. (Only DATABASE_URL is needed at build; worker/OpenAI env is read lazily.)
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
# Bring the fully-built app (node_modules incl. dev, .next, source, drizzle/ migrations, schema).
COPY --from=builder /app ./
EXPOSE 8080
# Default = web. The worker process overrides this with `npm run worker` (fly.toml [processes]).
CMD ["npm", "start"]
