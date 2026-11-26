# syntax=docker/dockerfile:1
FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Amazon RDS certificate bundle, so the database connection is verified (used when DB_CA_FILE points at it).
RUN mkdir -p /certs && wget -qO /certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY --from=build --chown=node:node /certs ./certs
USER node
EXPOSE 8080
# Applies new DB migrations and refreshes the exercise library (both idempotent), then starts the API.
CMD ["sh", "-c", "node dist/migrate.js && node dist/seed/exercises.js && node dist/server.js"]
