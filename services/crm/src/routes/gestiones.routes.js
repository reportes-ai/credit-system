'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/gestiones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Gestión de campañas Outbound por matriz (Perfiles y Permisos), no por nombre de
// perfil. Admin pasa por bypass.
const crearCampana    = requireFunc('crm_campanas_crear');
const gestionarCampana = requireFunc('crm_campanas_gestionar');

router.get('/',                   verifyToken, ctrl.list);
router.post('/',                  verifyToken, ctrl.create);
router.get('/estadisticas',       verifyToken, ctrl.stats);
router.get('/campanas',               verifyToken,                  ctrl.listCampanas);
router.post('/campanas',              verifyToken, crearCampana,    ctrl.createCampana);
router.get('/campanas/:id',            verifyToken,                  ctrl.getCampana);
router.put('/campanas/:id',            verifyToken, gestionarCampana, ctrl.updateCampana);
router.get('/campanas/:id/resultados', verifyToken,                  ctrl.resultadosCampana);
router.get('/historial/:rut',     verifyToken, ctrl.historialCliente);
router.get('/:id',                verifyToken, ctrl.getOne);
router.put('/:id',                verifyToken, ctrl.update);

module.exports = router;
