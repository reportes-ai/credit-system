'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/portal-cliente.controller');

// Público (enrolamiento + login del cliente final)
router.post('/solicitar-codigo', ctrl.solicitarCodigo);
router.post('/activar',          ctrl.activar);
router.post('/login',            ctrl.login);

// Sesión de cliente (JWT tipo=cliente; scope SIEMPRE al rut del token)
router.get('/resumen',      ctrl.verifyCliente, ctrl.resumen);
router.get('/credito/:id',  ctrl.verifyCliente, ctrl.detalle);
router.get('/info-pago',    ctrl.verifyCliente, ctrl.infoPago);

module.exports = router;
