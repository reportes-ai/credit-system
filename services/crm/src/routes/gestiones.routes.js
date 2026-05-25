'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/gestiones.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador', 'Gerente');

router.get('/',                   verifyToken, ctrl.list);
router.post('/',                  verifyToken, ctrl.create);
router.get('/estadisticas',       verifyToken, ctrl.stats);
router.get('/campanas',              verifyToken,             ctrl.listCampanas);
router.post('/campanas',             verifyToken, soloAdmin,  ctrl.createCampana);
router.get('/campanas/:id',           verifyToken,             ctrl.getCampana);
router.put('/campanas/:id',           verifyToken, soloAdmin,  ctrl.updateCampana);
router.get('/campanas/:id/resultados',verifyToken,             ctrl.resultadosCampana);
router.get('/historial/:rut',     verifyToken, ctrl.historialCliente);
router.get('/:id',                verifyToken, ctrl.getOne);
router.put('/:id',                verifyToken, ctrl.update);

module.exports = router;
