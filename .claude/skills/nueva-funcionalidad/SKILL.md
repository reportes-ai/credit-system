---
name: nueva-funcionalidad
description: Checklist de las máximas del proyecto para blindar un feature nuevo antes de darlo por terminado. Usar al terminar (o antes de commitear) cualquier funcionalidad nueva o cambio importante.
---

# Checklist de cierre de un feature (máximas de AutoFácil)

Aplica este checklist al cambio actual (diff sin commitear o último commit si el árbol está limpio). Para CADA punto: verificar en el código real, no de memoria. Reportar el resultado punto por punto con ✅/❌/N-A y corregir lo que falte ANTES de dar el feature por terminado.

## 1. Un solo motor por cálculo
- ¿El cambio calcula alguna magnitud de negocio (montos, tasas, fechas, comisiones, saldos)? Buscar dónde YA se computa esa magnitud (`grep` por el concepto) y reusar/extender el motor existente. Ninguna copia inline nueva.
- Fechas de "hoy" en el servidor: SIEMPRE `shared/fecha-chile.js` (`hoyISO()`/`isoDe()`), nunca `toISOString().slice(0,10)` — el trinquete `tests/patrones-fecha.test.js` lo vigila.

## 2. Una sola fuente de datos
- ¿Algún dato nuevo se re-almacena cuando ya vive en otra tabla? Referenciar (JOIN/FK), no copiar. Snapshot deliberado (congelar al otorgar/emitir) es la única excepción y también tiene UN solo hogar.

## 3. ¿Debería ser paramétrico?
- Por cada valor de negocio nuevo en el código (monto, umbral, texto, lista, mapeo): preguntarse "¿el Administrador debería poder cambiarlo sin programador?". Si sí → tabla de config + mantenedor, no hardcode.
- Si tocó un mantenedor: actualizar su footer "Qué afecta este mantenedor".

## 4. ¿Mueve plata?
- Si el cambio registra un ingreso o egreso: DEBE tener regla en Reglas de Centralización y pasar por `contabilizar()` (services/contabilidad/src/motor-asientos.js) en el MISMO commit. Devengo y pago son hechos distintos; impuestos van a su cuenta.

## 5. Permisos
- Rutas nuevas sensibles: `requireFunc('codigo')` en la ruta (nunca `requirePerfil`). Validaciones por fila/dueño van en el controller.
- Si hay card o módulo nuevo: INSERT en `funcionalidades`/`modulos` + `permisos_perfil` (nunca listas JS fijas).

## 6. Robustez
- UPDATEs críticos: revisar `affectedRows` (0 filas no lanza error solo).
- Estados en SQL: comparar con `UPPER(col)` y escribir en MAYÚSCULAS (BD case-sensitive).
- Validar entrada en todas las rutas nuevas. Respuesta uniforme `{ success, data, error }`.
- Archivos subidos: SIEMPRE por `shared/almacen-docs.js`, nunca LONGBLOB nuevo.
- Tareas de fondo: SIEMPRE `programar()` de `shared/scheduler.js`, nunca setInterval suelto.
- Migraciones: por el capataz `shared/migrate.js`.

## 7. Frontend
- Breadcrumb completo (`AF_TOPNAV`; en SPAs, `AF_TOPNAV_HOJA` al cambiar de vista).
- Badge de versión del HTML subido + `APP_VERSION` en `api-gateway/public/js/app-version.js` (menor si fix, mayor si feature).

## 8. Documentación (parte del feature, no "después")
- Actualizar el documento vivo que corresponda en /mantenedores/documentacion/ (técnica, procesos, manual, config-maestro) en el mismo commit o cierre de sesión.

## 9. Verificación final
- `npm test` en verde.
- Si el cambio es grande: sugerir a Pato lanzar `/code-review ultra` sobre la rama/base antes del push.
