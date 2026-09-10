'use strict';
/* Rutas de la API Pública (empresas externas, auth por X-API-Key) y su
   administración (mantenedor APIs, auth JWT + permiso apis_admin). */
const express = require('express');
const rateLimit = require('../../../../shared/rate-limit');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/api-publica.controller');

/* Pública: sin JWT — llave por empresa + rate limit 60 req/min por IP */
const publica = express.Router();
publica.get('/v1/simulador-rapido',
  rateLimit({ ventanaMs: 60000, max: 60, mensaje: 'Límite de 60 consultas por minuto excedido' }),
  c.validarApiKey('simulador_rapido'), c.simular);

/* Suite Financiera (JM): lectura de contabilidad, ODP, rentabilidad y saldos — llave propia, 120 req/min */
const fin = require('../controllers/api-finanzas.controller');
const rlFin = rateLimit({ ventanaMs: 60000, max: 120, mensaje: 'Límite de 120 consultas por minuto excedido' });
const kFin = c.validarApiKey('suite_financiera');
publica.get('/v1/finanzas/libro-mayor',          rlFin, kFin, fin.libroMayor);
publica.get('/v1/finanzas/libro-mayor-completo', rlFin, kFin, fin.libroMayorCompleto);
publica.get('/v1/finanzas/balance',              rlFin, kFin, fin.balance);
publica.get('/v1/finanzas/libro-compras',        rlFin, kFin, fin.libroCompras);
publica.get('/v1/finanzas/libro-ventas',         rlFin, kFin, fin.libroVentas);
publica.get('/v1/finanzas/ordenes-pago',         rlFin, kFin, fin.ordenesPago);
publica.get('/v1/finanzas/rentabilidad',         rlFin, kFin, fin.rentabilidad);
publica.get('/v1/finanzas/saldo-proceso-pago',   rlFin, kFin, fin.saldoProcesoPago);
/* Buzón: la empresa (o su asistente) pregunta y lee respuestas con la misma llave */
const msj = require('../controllers/api-mensajes.controller');
const rlMsj = rateLimit({ ventanaMs: 60000, max: 20, mensaje: 'Límite de 20 mensajes por minuto excedido' });
publica.post('/v1/finanzas/mensajes', express.json({ limit: '64kb' }), rlMsj, kFin, msj.publicar);
publica.get('/v1/finanzas/mensajes',  rlFin, kFin, msj.leer);

/* Admin: mantenedor APIs */
const admin = express.Router();
admin.use(verifyToken, requireFunc('apis_admin'));
admin.get('/catalogo', c.adminCatalogo);
admin.get('/', c.adminListar);
admin.post('/', c.adminCrear);
admin.put('/:id/activo', c.adminActivo);
admin.get('/mensajes', msj.adminListar);
admin.post('/mensajes/responder', msj.adminResponder);
admin.post('/:id/regenerar', c.adminRegenerar);

module.exports = { publica, admin };
