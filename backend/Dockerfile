# =============================================================================
# AdiOne API — production image
# =============================================================================

FROM node:20-alpine AS build
WORKDIR /app

# Prisma requires OpenSSL on Alpine
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

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
COPY --from=build --chown=adione:adione /app/prisma ./prisma
COPY --chown=adione:adione package*.json ./

USER adione

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]