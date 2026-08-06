'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/endpoints-catalogo.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/', verifyToken, requireFunc('mant_endpoints'), ctrl.catalogo);

module.exports = router;
