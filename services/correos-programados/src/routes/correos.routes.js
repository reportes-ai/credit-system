'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/correos.controller');

router.get('/', verifyToken, c.listar);
// Escrituras por la matriz (antes esAdmin() por nombre de perfil, hardcodeado):
router.put('/:codigo', verifyToken, requireFunc('mantenedores_correos_programados'), c.actualizar);
router.post('/:codigo/enviar-ahora', verifyToken, requireFunc('mantenedores_correos_programados'), c.enviarAhora);
router.get('/:codigo/preview', verifyToken, c.preview);

module.exports = router;
