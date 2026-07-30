'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/cartolas.controller');

// Incorporar a cartola las otorgadas SIN carta de aprobación (carga masiva).
// Van ANTES de '/:id' para que no las capture esa ruta.
const inc = require('../controllers/cartola-incorporaciones.controller');
router.get('/sin-carta',          verifyToken, requireFunc('cartola_incorporar'), inc.sinCarta);
router.get('/comision-motor',     verifyToken, requireFunc('cartola_incorporar'), inc.comisionQueCorresponde);
router.post('/incorporar',        verifyToken, requireFunc('cartola_incorporar'), inc.incorporar);
router.get('/incorporaciones',    verifyToken, requireFunc('cartola_incorporar', 'cartola_incorp_aprobar'), inc.listarIncorporaciones);
router.put('/incorporaciones/:id', verifyToken, requireFunc('cartola_incorp_aprobar'), inc.resolver);

router.post('/sync',        verifyToken, c.sync);
router.get('/enviadas',     verifyToken, c.getEnviadas);
router.post('/enviadas',    verifyToken, c.registrarEnvio);
router.delete('/enviadas/:id', verifyToken, requireFunc('aprob_cartola_reversar'), c.reversarEnvio);
router.get('/',             verifyToken, c.getMovimientos);
router.post('/',            verifyToken, requireFunc('aprob_cartolas'), c.crearMovimiento);
router.put('/:id',          verifyToken, requireFunc('aprob_cartolas'), c.updateMovimiento);
router.delete('/:id',       verifyToken, requireFunc('aprob_cartolas'), c.deleteMovimiento);

module.exports = router;
