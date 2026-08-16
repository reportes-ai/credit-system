---
name: auditoria-permisos
description: Auditoria adversarial multi-agente sobre una dimension del codigo (permisos, SQL injection, affectedRows, validacion de entrada, etc.). Solo hallazgos CONFIRMADOS llegan a Pato.
---

# Auditoría adversarial por dimensión

Método probado el 16-08-2026 (2 hoyos reales de permisos + 14 bugs de fecha, con CERO falsos positivos entregados). Si Pato no indicó la dimensión, preguntarle cuál: permisos requireFunc · inyección SQL · affectedRows en UPDATEs críticos · validación de entrada · estados sin UPPER() · setInterval sueltos · otra.

## El método (respetarlo completo)

1. **Barrido amplio** con un Workflow multi-agente: dividir services/ + shared/ + api-gateway/ en zonas y lanzar agentes de búsqueda en paralelo, cada uno reportando candidatos con archivo:línea y evidencia (schema estructurado).
2. **Verificación adversarial**: por CADA candidato, un agente verificador que lee el código real completo y trata de REFUTAR el hallazgo (¿hay control más adentro? ¿la ruta es inalcanzable? ¿es diseño deliberado por fila/dueño?). En duda → refutado.
3. **Solo lo CONFIRMADO se reporta a Pato**, clasificado por gravedad, con el fix propuesto. Los refutados se resumen en una línea (cuántos y por qué), no en detalle.
4. **Tras corregir** (solo con aprobación de Pato): dejar un guardián que impida el retroceso — prueba trinquete con baseline por archivo (patrón `tests/patrones-fecha.test.js`) o vigía según corresponda.

## Lecciones aprendidas (no repetir errores)

- Los falsos positivos se descartan LEYENDO el controller, no de memoria (Concurso tenía exigirEditor; Facilbook validaba autor).
- Validaciones por fila/dueño (jefatura, solicitante, titular de firma, Caja Activa) NO son expresables en la matriz de permisos: son diseño correcto en el controller, no hoyos.
- Al migrar un chequeo a requireFunc: usar LOS MISMOS códigos que ya validaba adentro (doble defensa), nunca inventar códigos nuevos.
- El output completo del workflow queda en su archivo de tasks — citarlo para trazabilidad.
