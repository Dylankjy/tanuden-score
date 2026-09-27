# ---- Stage 1: Dev (bind mount + nodemon, used by docker compose target) ----
FROM node:24-alpine AS dev
WORKDIR /app

ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "dev"]

# ---- Stage 2: Build ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: Production ----
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 5005

CMD ["node", "./dist/index.js"]
