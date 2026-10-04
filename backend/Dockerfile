# =============================================================================
# AdiOne API — production image
# =============================================================================

FROM node:20-alpine AS build
WORKDIR /app

# Prisma requires OpenSSL on Alpine
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

# V2 only: the client is generated from prisma-v2/schema.prisma. The V1
# history in prisma/migrations is never copied into the image, so nothing in
# the container can apply it.
COPY prisma-v2 ./prisma-v2
COPY prisma/seed ./prisma/seed
RUN npx prisma generate --schema=prisma-v2/schema.prisma

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev


FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Prisma runtime + dumb-init
RUN apk add --no-cache dumb-init openssl

RUN addgroup -g 1001 adione && adduser -u 1001 -G adione -s /bin/sh -D adione

COPY --from=build --chown=adione:adione /app/node_modules ./node_modules
COPY --from=build --chown=adione:adione /app/dist ./dist
# V2 schema + migrations for `prisma migrate deploy`, the V1-database guard it
# runs first (see docker-compose.prod.yml), and the seed sources.
COPY --from=build --chown=adione:adione /app/prisma-v2 ./prisma-v2
COPY --from=build --chown=adione:adione /app/prisma/seed ./prisma/seed
COPY --chown=adione:adione scripts/assert-v2-database.mjs ./scripts/assert-v2-database.mjs
COPY --chown=adione:adione package*.json ./

USER adione

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]