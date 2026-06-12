'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/ayuda.controller');

router.get('/todas', verifyToken, requireFunc('mantenedores_ayuda'), c.listAyuda);
router.get('/', verifyToken, c.getAyuda);
// Edición desde el mantenedor de Ayuda
router.put('/:ruta?', verifyToken, requireFunc('mantenedores_ayuda'), c.upsertAyuda);

module.exports = router;
