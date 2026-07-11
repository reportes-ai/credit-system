'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c          = require('../controllers/tablas-dinamicas.controller');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/fuentes',           verifyToken, c.getFuentes);
router.post('/ejecutar',         verifyToken, requireFunc('reportería_ver'), c.ejecutar);
router.get('/guardadas',         verifyToken, c.getGuardadas);
router.get('/guardadas/:id',     verifyToken, c.getGuardadaById);
router.post('/guardadas',        verifyToken, requireFunc('reportería_ver'), c.guardar);
router.put('/guardadas/:id',     verifyToken, requireFunc('reportería_ver'), c.actualizar);
router.delete('/guardadas/:id',  verifyToken, requireFunc('reportería_ver'), c.eliminar);

module.exports = router;
