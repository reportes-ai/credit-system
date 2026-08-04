# ─────────────────────────────────────────────────────────────────────────────
#  Render NO usa este archivo: allá la app corre como servicio Node (package.json).
#  Acá se usa para DOS cosas:
#
#   1) CONTINGENCIA LOCAL — levantar la Suite completa en un computador
#      cualquiera, sin Render y sin TiDB:
#        · node scripts/volcar-bd.js     → vuelca la BD a docker/init/dump.sql
#        · docker-compose up -d --build  → MySQL 8 + la app en localhost:3000
#
#   2) HOST ALTERNATIVO en Google Cloud Run (docs/plan-staging-prod.md). Cloud
#      Build construye ESTA imagen. Por eso la versión de Node debe calzar con la
#      del CI y la de producción: un host de contingencia que corre otro motor no
#      es contingencia, es una sorpresa esperando la emergencia.
#
#  OJO: al crear un servicio nuevo en Render, este archivo hace que autodetecte
#  "Docker" — hay que forzar Language: Node (pasó el 30-07-2026 en la mudanza).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copiar dependencias primero (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar todo el código
COPY . .

EXPOSE 3000

# Arranque SIN `--max-old-space-size`, a diferencia de `npm start`. Ese flag fija
# el heap en 1536 MB, que calza con los 2 GB de Render pero mataría un contenedor
# de 512 MB. Sin el flag, Node dimensiona el heap según la memoria que el
# contenedor de verdad tiene — que es el comportamiento correcto acá.
# Cloud Run inyecta su propia variable PORT y el gateway la respeta.
CMD ["node", "api-gateway/src/index.js"]
