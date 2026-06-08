const router = require('express').Router();
const ctrl   = require('../controllers/trinidad-config.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

// Estados
router.get   ('/estados',       verifyToken, ctrl.getEstados);
router.post  ('/estados',       verifyToken, soloAdmin, ctrl.createEstado);
router.put   ('/estados/:id',   verifyToken, soloAdmin, ctrl.updateEstado);
router.delete('/estados/:id',   verifyToken, soloAdmin, ctrl.deleteEstado);

// Ejecutivos
router.get   ('/ejecutivos-af',   verifyToken, ctrl.getEjecutivosAF);
router.get   ('/ejecutivos',      verifyToken, ctrl.getEjecutivos);
router.post  ('/ejecutivos',      verifyToken, soloAdmin, ctrl.createEjecutivo);
router.put   ('/ejecutivos/:id',  verifyToken, soloAdmin, ctrl.updateEjecutivo);
router.delete('/ejecutivos/:id',  verifyToken, soloAdmin, ctrl.deleteEjecutivo);

module.exports = router;
