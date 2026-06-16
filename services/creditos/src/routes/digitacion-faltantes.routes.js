'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/digitacion-faltantes.controller');

// Pool de digitación de datos faltantes (créditos incompletos por carga masiva).
router.get ('/conteo',           verifyToken, requireFunc('digitacion_faltantes'), ctrl.conteo);
router.get ('/siguiente',        verifyToken, requireFunc('digitacion_faltantes'), ctrl.siguiente);
router.get ('/dealer-buscar',    verifyToken, requireFunc('digitacion_faltantes'), ctrl.dealerBuscar);
router.get ('/estadisticas',     verifyToken, ctrl.estadisticas);   // gateado por perfil dentro
router.post('/:id(\\d+)',        verifyToken, requireFunc('digitacion_faltantes'), ctrl.guardar);
router.post('/:id(\\d+)/liberar',verifyToken, requireFunc('digitacion_faltantes'), ctrl.liberar);

module.exports = router;
