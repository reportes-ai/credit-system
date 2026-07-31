'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/saldo-proceso-pago.controller');

router.get('/', verifyToken, requireFunc('teso_saldo_proceso'), c.listar);

module.exports = router;
