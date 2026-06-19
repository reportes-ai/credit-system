'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/cobranza.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Parámetros de Cobranza (mantenedor)
router.get('/parametros',             verifyToken, ctrl.getParametros);
router.put('/parametros',             verifyToken, requireFunc('mant_cobranza_parametros'), ctrl.setParametros);
router.post('/calcular-gasto',        verifyToken, ctrl.calcularGasto);
router.post('/calcular-cobranza',     verifyToken, ctrl.calcularCobranza);
router.post('/calcular-cobranza-lote',verifyToken, ctrl.calcularCobranzaLote);

// Rutas estáticas primero
router.get('/diagnostico',            verifyToken, ctrl.diagnostico);
router.get('/dashboard',              verifyToken, ctrl.dashboard);
router.get('/cartera',                verifyToken, ctrl.cartera);
router.get('/provisiones',            verifyToken, ctrl.provisiones);
router.get('/mis-gestiones',          verifyToken, ctrl.misGestiones);
router.post('/gestiones',             verifyToken, ctrl.crearGestion);
router.put('/gestiones/:id/confirmar',verifyToken, ctrl.confirmarGestion);

// Rutas con parámetro al final
router.get('/disponibilidad/:id_credito', verifyToken, ctrl.disponibilidad);
router.get('/mensajes/:id_credito',       verifyToken, ctrl.mensajes);
router.put('/contacto/:id_credito',       verifyToken, ctrl.guardarContacto);
router.get('/bitacora/:id_credito',       verifyToken, ctrl.bitacora);

module.exports = router;
