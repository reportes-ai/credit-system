'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/comisiones-parques.controller');

const ver = requireFunc('postventa_comisiones_parques');

router.get('/',         verifyToken, ver, c.listar);
router.get('/detalle',  verifyToken, ver, c.detalle);
router.post('/aprobar', verifyToken, requireFunc('pv_parques_aprobar'), c.aprobar);
router.post('/emitir',  verifyToken, requireFunc('pv_parques_emitir'),  c.emitir);
router.post('/pagar',   verifyToken, requireFunc('pv_parques_pagar'),   c.pagar);

module.exports = router;
