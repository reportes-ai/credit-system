'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/ayuda.controller');

router.get('/', verifyToken, c.getAyuda);
// Edición de ayuda: reservada al futuro mantenedor (Admin / permiso)
router.put('/:ruta?', verifyToken, requireFunc('ayuda_editar'), c.upsertAyuda);

module.exports = router;
