'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/bancos.controller');

router.get('/', verifyToken, c.listar);                                 // cualquier usuario logueado (selectores)
router.put('/', verifyToken, requireFunc('mant_bancos'), c.guardar);   // mantenedor Bancos de la Plaza

module.exports = router;
