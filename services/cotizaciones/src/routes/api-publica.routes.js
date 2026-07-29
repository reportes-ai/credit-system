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
  c.validarApiKey, c.simular);

/* Admin: mantenedor APIs */
const admin = express.Router();
admin.use(verifyToken, requireFunc('apis_admin'));
admin.get('/', c.adminListar);
admin.post('/', c.adminCrear);
admin.put('/:id/activo', c.adminActivo);
admin.post('/:id/regenerar', c.adminRegenerar);

module.exports = { publica, admin };
