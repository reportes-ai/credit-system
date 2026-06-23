'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c = require('../controllers/correos.controller');

router.get('/', verifyToken, c.listar);
router.put('/:codigo', verifyToken, c.actualizar);
router.post('/:codigo/enviar-ahora', verifyToken, c.enviarAhora);
router.get('/:codigo/preview', verifyToken, c.preview);

module.exports = router;
