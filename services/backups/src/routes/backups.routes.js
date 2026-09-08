'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c = require('../controllers/backups.controller');

router.get('/mio',  verifyToken, c.mio);        // autoservicio: mi suplente (va ANTES de /:id_titular)
router.put('/mio',  verifyToken, c.guardarMio);
router.get('/', verifyToken, c.listar);
router.put('/:id_titular', verifyToken, c.guardar);

module.exports = router;
