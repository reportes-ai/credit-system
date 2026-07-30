# ─────────────────────────────────────────────────────────────────────────────
#  NO se usa en producción. Render corre la app como servicio Node (ver package.json).
#  Esto es la CONTINGENCIA LOCAL: levantar la Suite completa en un computador
#  cualquiera, sin Render y sin TiDB.
#     1) node scripts/volcar-bd.js     → vuelca la BD a docker/init/dump.sql
#     2) docker-compose up -d --build  → MySQL 8 + la app en localhost:3000
#  OJO: al crear un servicio nuevo en Render, este archivo hace que autodetecte
#  "Docker" — hay que forzar Language: Node (pasó el 30-07-2026 en la mudanza).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copiar dependencias primero (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar todo el código
COPY . .

EXPOSE 3000

CMD ["node", "api-gateway/src/index.js"]
