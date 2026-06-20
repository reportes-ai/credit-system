'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const C = require('../controllers/ia-config.controller');

router.get('/', verifyToken, C.getConfig);                         // lo lee el branding (cualquier usuario)
router.put('/', verifyToken, requireFunc('mant_ia'), C.setConfig); // editar — Admin / con permiso

module.exports = router;
