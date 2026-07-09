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
router.post('/enviar/:id_credito',        verifyToken, ctrl.enviarMensaje);
router.put('/contacto/:id_credito',       verifyToken, ctrl.guardarContacto);
router.get('/bitacora/:id_credito',       verifyToken, ctrl.bitacora);

// Reportería Cobranzas (informes agregados, read-only)
const rep = require('../controllers/reportes.controller');
router.get('/reportes/ejecutivos',   verifyToken, rep.ejecutivos);
router.get('/reportes/rendimiento',  verifyToken, rep.rendimiento);
router.get('/reportes/gestiones',    verifyToken, rep.gestiones);
router.get('/reportes/recuperacion', verifyToken, rep.recuperacion);
router.get('/reportes/mora-stock',   verifyToken, rep.moraStock);
router.get('/reportes/cartera',      verifyToken, rep.cartera);

module.exports = router;
