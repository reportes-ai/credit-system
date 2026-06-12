'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/alertas.controller');

router.get('/meta',    verifyToken, requireFunc('mantenedores_alertas'), c.getMeta);
router.get('/',        verifyToken, requireFunc('mantenedores_alertas'), c.listAlertas);
router.post('/',       verifyToken, requireFunc('mantenedores_alertas'), c.saveAlerta);
router.delete('/:id',  verifyToken, requireFunc('mantenedores_alertas'), c.deleteAlerta);

module.exports = router;
