'use strict';
// Universo canónico de colaboradores (Máxima 2 — una sola fuente): quiénes cuentan
// como personas de la empresa en TODOS los consumidores (analytics, vacaciones,
// encuestas, desempeño, selectores). Criterio único: usuario activo y NO marcado
// no_mostrar en su ficha (cuentas técnicas y externos se marcan ahí, desde
// Colaboradores). en_directorio/en_organigrama (rh_directorio_config) son SOLO
// visibilidad del directorio; protegido es SOLO candado de edición — ninguno de
// los dos define el universo.
// Uso: FROM `${UNIVERSO_FROM}` WHERE `${UNIVERSO_WHERE}` (alias de usuarios: u)

const UNIVERSO_FROM = `usuarios u LEFT JOIN rh_fichas unm ON unm.id_usuario = u.id_usuario`;
const UNIVERSO_WHERE = `u.estado = 'activo' AND COALESCE(unm.no_mostrar, 0) = 0`;

module.exports = { UNIVERSO_FROM, UNIVERSO_WHERE };
