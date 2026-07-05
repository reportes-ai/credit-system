# Portal Parques Automotrices — Marketplace de Autos Usados (Propuesta)

> Estado: PROPUESTA (2026-07-04). Pendiente aprobación de Pato antes de construir.
> Investigación: mejores portales del mundo (Carvana, CarMax, AutoTrader UK, Carsales, Kavak) + Chile (Chileautos, Yapo, Kavak CL, Autofact) + maqueta de fotos de cvautos.cl.

## 1. Concepto

Marketplace público multi-dealer donde los **locatarios de los parques automotrices** publican su stock. Los compradores buscan no solo por marca/precio, sino por **estilo de vida con IA**, cotizan su crédito con **AutoFácil** y **reservan online con abono** ($100.000 por 24 h, ambos parametrizables).

Modelo de negocio: acceso **gratis para dealers** a cambio de disciplina (maqueta de fotos obligatoria en orden, bloquear reservados, retirar vendidos). AutoFácil monetiza vía **créditos originados** + banners propios en el portal.

Lección clave de la investigación: el modelo marketplace multi-dealer (sin stock propio) es el sostenible — Cazoo (UK) quebró comprando inventario; Chileautos/Carsales viven bien del clasificado + servicios.

## 2. Layout

- **Header**: logo Parques Automotrices + **banner animado AutoFácil** (carrusel de avisos rotativos, administrable desde mantenedor: imagen/gif, link, orden, vigencia).
- **Buscador**: barra IA conversacional al centro ("Busco algo familiar, seguro, para salir de la ciudad, hasta $9M") + filtros clásicos colapsables (marca→modelo dependiente, año, precio, km, transmisión, combustible, categoría, parque/dealer).
- **Grilla de autos** (cards) debajo.
- Footer con parques adheridos + link cotizador.

### Card del auto (basada en cvautos.cl + mejoras)
- Foto portada (frontal 3/4) + badge estado (Disponible / **RESERVADO** / Oportunidad / Único dueño…)
- MARCA MODELO + versión, precio formato es-CL
- Año | Km | Transmisión | Combustible (íconos)
- **"Cuota desde $X/mes"** calculada con el motor de cotización AutoFácil — nadie en Chile lo hace; en Carvana es el driver #1 de conversión
- Nombre del dealer + parque

### Ficha de detalle
- Carrusel con la maqueta de 13 fotos, encabezado con datos clave y precio
- Equipamiento (checks), descripción del dealer, mapa del parque (Leaflet — ya lo usamos en dealers-mapa)
- Panel derecho: **Cotiza tu crédito AutoFácil** (simulador embebido: pie + cuotas → cuota estimada) + **Reservar por $100.000** + WhatsApp del dealer
- Autos sugeridos por IA al pie

## 3. Maqueta de fotos obligatoria (orden cvautos.cl)

Vuelta exterior horaria desde el frontal 3/4, luego interior de afuera hacia adentro:

1. Frontal 3/4 izquierdo (portada)
2. Lateral izquierdo
3. Trasera 3/4 izquierda
4. Trasera directa
5. Trasera 3/4 derecha
6. Lateral derecho
7. Frontal 3/4 derecho
8. Frontal directa
9. **Odómetro encendido** (acredita km)
10. Volante + tablero desde la puerta
11. Pantalla central encendida
12. Consola central
13. Tablero panorámico desde atrás

Mejora propia (opcionales 14-16): maletero, motor, rueda/llanta. El uploader del dealer muestra **slots numerados con silueta guía** de cada toma; no se puede publicar sin las 13 obligatorias (validación dura = la "obligación" del acceso gratis). Fotos horizontales, se recomprimen server-side a webp.

## 4. Búsqueda con IA por estilo de vida

Formulario/conversación opcional ("Ayúdame a elegir"): género, edad, colores preferidos, estado civil, hijos, tamaño del grupo familiar, si sale seguido fuera de la ciudad, uso (trabajo/familia/aventura/ciudad), presupuesto o pie disponible.

- Motor: subsistema IA Anthropic ya existente (paramétrico, con tracking de tokens). El modelo recibe el perfil + el catálogo filtrado (JSON compacto) y devuelve un **shortlist rankeado con razones** ("Por tu familia de 5 y salidas frecuentes: SUV 7 asientos…").
- Cada recomendación muestra la **cuota simulada** según su pie declarado.
- Fallback sin IA: reglas por categoría (familia grande→SUV/minivan, fuera de ciudad→4x4/SUV, ciudad→hatchback) para cuando IA esté off.
- El perfil declarado queda guardado (lead calificado para el dealer y para campañas).

## 5. Reserva online

- Abono **$100.000** por **24 horas** — ambos en mantenedor (portal_parametros).
- Flujo: ficha → Reservar → datos + RUT → pago (Webpay/Transbank u orden de transferencia en fase 1) → auto pasa a **RESERVADO** en todo el portal (badge, no se puede volver a reservar) → correo al dealer y al cliente.
- Vencimiento automático por cron (motor de correos programados existente): si no se concreta en 24 h, vuelve a DISPONIBLE y se notifica.
- Dealer puede confirmar venta (auto sale del portal, queda historial) o liberar.
- Política de devolución del abono: parametrizable (reembolsable si no compra / abonable al pie).

## 6. Accesos y roles

- **Comprador**: público, sin login para buscar; datos solo al cotizar/reservar.
- **Locatario (dealer)**: cuenta propia (reutilizar patrón Portal del Dealer ya construido: JWT con aislamiento por dealer). Panel: publicar/editar/pausar autos, uploader maqueta, marcar reservado/vendido, ver leads y reservas.
- **Parque**: ve todos los dealers de su parque (usa dealers↔parques ya existente).
- **AutoFácil admin**: mantenedor de banners, parámetros de reserva, moderación de publicaciones, dashboard de leads/reservas/créditos originados.

## 7. Obligaciones del dealer (términos del acceso gratis)

1. 13 fotos de la maqueta en el orden establecido (validación dura al publicar).
2. Marcar RESERVADO apenas se comprometa el auto por otro canal.
3. Retirar el auto apenas se venda (o confirmar venta de reserva).
4. Antigüedad de aviso: alerta automática a los N días sin actualizar (parametrizable) → aviso pausado si no confirma vigencia ("¿sigue disponible?"), para que el catálogo nunca tenga autos fantasma — el dolor #1 de Yapo/Chileautos.

## 8. Diferenciadores (del benchmark, aplicables por fases)

Fase 1 (lanzamiento):
- Cuota AutoFácil en cada card (único en Chile)
- Búsqueda IA por estilo de vida
- Reserva online con abono y bloqueo cross-canal
- Maqueta de fotos uniforme (catálogo se ve profesional tipo cvautos)

Fase 2:
- **Pre-aprobación con RUT en 2 min** (integración DealerNet existente) → "estos son los autos que puedes pagar"
- **Informe Autofact embebido** con semáforo (prenda/multas/RT) en cada ficha
- **Price Indicator** (precio vs mercado del propio portal): confianza comprador + dato para el dealer

Fase 3:
- Trade-in: "deja tu auto en parte de pago" con tasación → pie del crédito
- Transferencia digital (partner Autofact) al aprobar el crédito
- Sello "Verificado en parque" con checklist de inspección publicado

## 9. Arquitectura técnica (dentro del credit-system)

- `services/marketplace/` nuevo + frontend público en `api-gateway/public/portal-autos/` (mismo patrón que portal-dealer/portal-cliente).
- Tablas: `mkt_publicaciones` (FK dealer, datos vehículo, precio, estado DISPONIBLE/RESERVADO/VENDIDO/PAUSADO), `mkt_fotos` (publicación, slot 1-16, url), `mkt_reservas` (publicación, rut, abono, vence_at, estado), `mkt_leads` (perfil estilo de vida + contacto), `mkt_banners`, `portal_parametros` (abono, horas, N días vigencia).
- Estados de publicación: máquina paramétrica reutilizando `estados_credito`/`estados_transicion` con ámbito nuevo `marketplace` (filosofía paramétrica).
- Fotos: almacenar en el mismo storage que documentos actuales; recompresión webp server-side.
- Cotizador: **motor único** — reutilizar el simulador de cotizaciones existente vía API pública acotada (sin exponer parámetros internos).
- IA: `shared/` subsistema Anthropic existente, feature flag propio.
- Dominio: apuntar parquesautomotrices.cl (hoy NO resuelve — confirmar dominio/branding) al mismo Render o a un servicio aparte.

## 10. Decisiones tomadas (Pato, 2026-07-04)

1. **Dominio**: parquesautomotrices.cl es de Pato (aún sin publicar). **Sin logo todavía** — diseñar uno provisorio.
2. **Pago del abono fase 1**: transferencia bancaria con comprobante (Webpay en fase posterior).
3. **Abono reembolsable** si no se concreta la compra.
4. **Proyecto SEPARADO**: repo propio + servicio Render propio. Es negocio personal de Pato, NO de la empresa → el código NO vive en credit-system. La integración con AutoFácil (cotizador, banners) se hace vía API entre servicios.
5. Este documento queda solo como referencia histórica de la propuesta; el desarrollo continúa en el repo nuevo (sugerido: `parques-automotrices`).
