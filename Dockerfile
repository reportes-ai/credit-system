FROM node:20-alpine

WORKDIR /app

# Copiar dependencias primero (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar todo el código
COPY . .

EXPOSE 3000

CMD ["node", "api-gateway/src/index.js"]
