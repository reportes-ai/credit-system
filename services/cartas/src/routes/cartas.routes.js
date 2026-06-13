'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/cartas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',  verifyToken, ctrl.getAll);
router.post('/', verifyToken, ctrl.upsert);   // create o update según body.id
router.post('/carga-masiva', verifyToken, requireFunc('aprob_carga_masiva'), ctrl.cargaMasivaCartas);

module.exports = router;
