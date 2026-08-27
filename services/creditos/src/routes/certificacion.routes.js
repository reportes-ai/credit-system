'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/certificacion.controller');

// Certificación manual de operaciones otorgadas (valores vs carta / Trinidad)
router.get ('/pendientes',       verifyToken, requireFunc('certificacion_ops'), ctrl.pendientes);
router.get ('/detalle/:id',      verifyToken, requireFunc('certificacion_ops'), ctrl.detalle);
router.post('/:id/certificar',   verifyToken, requireFunc('certificacion_certificar'), ctrl.certificar);
router.post('/:id/carta-actualizada', verifyToken, requireFunc('certificacion_certificar'), ctrl.subirCartaActualizada);
router.get ('/reporte',          verifyToken, requireFunc('certificacion_ops'), ctrl.reporte);
router.get ('/asignados',        verifyToken, requireFunc('certificacion_admin'), ctrl.asignados);
router.put ('/asignados/:idUsuario', verifyToken, requireFunc('certificacion_admin'), ctrl.setAsignado);
router.get ('/mias',             verifyToken, ctrl.mias);   // pop-up global: solo cuenta lo propio

module.exports = router;
