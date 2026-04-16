FROM node:lts-slim AS builder

USER node

WORKDIR /build

COPY package*.json ./
COPY vite.config.js ./

# Install production dependencies
RUN npm ci 

COPY . .

# Build the application
RUN npm run build

# Production image
FROM node:lts-slim AS runner

USER node

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY --from=builder --chown=node:node /build/dist ./dist

EXPOSE 8080

CMD ["npm", "run", "serve"]