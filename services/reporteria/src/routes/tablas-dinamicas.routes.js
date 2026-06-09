'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c          = require('../controllers/tablas-dinamicas.controller');

router.get('/fuentes',           verifyToken, c.getFuentes);
router.post('/ejecutar',         verifyToken, c.ejecutar);
router.get('/guardadas',         verifyToken, c.getGuardadas);
router.get('/guardadas/:id',     verifyToken, c.getGuardadaById);
router.post('/guardadas',        verifyToken, c.guardar);
router.put('/guardadas/:id',     verifyToken, c.actualizar);
router.delete('/guardadas/:id',  verifyToken, c.eliminar);

module.exports = router;
