# Aspire Test Platform
FROM node:20-alpine

# better-sqlite3 needs build tools on alpine (has prebuilds for most, keep tools as fallback)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
RUN apk del python3 make g++

COPY . .
RUN mkdir -p data

ENV NODE_ENV=production
EXPOSE 3000

# Persist ./data (SQLite file) with a volume in production
CMD ["node", "backend/server.js"]
