'use strict';
const express = require('express');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/tef.controller');

const router = express.Router();
// Quien genera nómina en cualquiera de las tres pantallas de pago puede generar el archivo TEF
const puede = requireFunc('pv_nomina_generar', 'pv_com_nomina_generar', 'pv_parques_pagar');
router.get('/cupo',           verifyToken, puede, c.cupo);
router.post('/internacional', verifyToken, puede, c.generar);

module.exports = router;
