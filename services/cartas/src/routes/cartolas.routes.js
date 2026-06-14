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
router.post('/',            verifyToken, c.crearMovimiento);
router.put('/:id',          verifyToken, c.updateMovimiento);
router.delete('/:id',       verifyToken, c.deleteMovimiento);

module.exports = router;
