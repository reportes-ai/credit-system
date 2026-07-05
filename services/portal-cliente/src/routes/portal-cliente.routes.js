'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/portal-cliente.controller');
const rateLimit = require('../../../../shared/rate-limit');

// Público (enrolamiento + login del cliente final) — limitado por IP (QA 15.5)
const limitePublico = rateLimit({ ventanaMs: 60000, max: 10 });
router.post('/solicitar-codigo', limitePublico, ctrl.solicitarCodigo);
router.post('/activar',          limitePublico, ctrl.activar);
router.post('/login',            limitePublico, ctrl.login);

// Sesión de cliente (JWT tipo=cliente; scope SIEMPRE al rut del token)
router.get('/resumen',      ctrl.verifyCliente, ctrl.resumen);
router.get('/credito/:id',  ctrl.verifyCliente, ctrl.detalle);
router.get('/info-pago',    ctrl.verifyCliente, ctrl.infoPago);

module.exports = router;
