'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c = require('../controllers/backups.controller');

router.get('/', verifyToken, c.listar);
router.put('/:id_titular', verifyToken, c.guardar);

module.exports = router;
