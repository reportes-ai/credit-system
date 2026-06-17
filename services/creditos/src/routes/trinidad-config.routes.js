const router = require('express').Router();
const ctrl   = require('../controllers/trinidad-config.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const puedeEstados    = requireFunc('cm_eq_estados');
const puedeEjecutivos = requireFunc('cm_eq_ejecutivos');

// Estados (Equivalencias Trinidad)
router.get   ('/estados',       verifyToken, ctrl.getEstados);
router.post  ('/estados',       verifyToken, puedeEstados, ctrl.createEstado);
router.put   ('/estados/:id',   verifyToken, puedeEstados, ctrl.updateEstado);
router.delete('/estados/:id',   verifyToken, puedeEstados, ctrl.deleteEstado);

// Ejecutivos (Equivalencia Ejecutivos)
router.get   ('/ejecutivos-af',   verifyToken, ctrl.getEjecutivosAF);
router.get   ('/ejecutivos',      verifyToken, ctrl.getEjecutivos);
router.post  ('/ejecutivos',      verifyToken, puedeEjecutivos, ctrl.createEjecutivo);
router.put   ('/ejecutivos/:id',  verifyToken, puedeEjecutivos, ctrl.updateEjecutivo);
router.delete('/ejecutivos/:id',  verifyToken, puedeEjecutivos, ctrl.deleteEjecutivo);

module.exports = router;
