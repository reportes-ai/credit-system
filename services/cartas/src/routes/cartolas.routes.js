'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/cartolas.controller');

router.post('/sync',        verifyToken, c.sync);
router.get('/enviadas',     verifyToken, c.getEnviadas);
router.post('/enviadas',    verifyToken, c.registrarEnvio);
router.delete('/enviadas/:id', verifyToken, requireFunc('aprob_cartola_reversar'), c.reversarEnvio);
router.get('/',             verifyToken, c.getMovimientos);
router.post('/',            verifyToken, requireFunc('aprob_cartolas'), c.crearMovimiento);
router.put('/:id',          verifyToken, requireFunc('aprob_cartolas'), c.updateMovimiento);
router.delete('/:id',       verifyToken, requireFunc('aprob_cartolas'), c.deleteMovimiento);

module.exports = router;
