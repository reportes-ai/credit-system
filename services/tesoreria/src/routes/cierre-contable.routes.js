'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/cierre-contable.controller');

const puede = requireFunc('cierre_contable');

router.get('/tabla-desarrollo',        verifyToken, puede, c.tablaDesarrollo);
router.get('/',                        verifyToken, puede, c.informe);
router.put('/saldo-pagado/:num_op',    verifyToken, puede, c.marcarSaldo);
router.put('/:mes',                    verifyToken, puede, c.guardar);

module.exports = router;
