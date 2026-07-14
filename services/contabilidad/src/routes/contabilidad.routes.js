'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/contabilidad.controller');

// Plan de cuentas
router.get('/cuentas',            verifyToken, requireFunc('ctb_ver', 'ctb_plan', 'ctb_comprobantes', 'ctb_libros', 'ctb_balance'), ctrl.getCuentas);
router.post('/cuentas',           verifyToken, requireFunc('ctb_plan'), ctrl.crearCuenta);
router.put('/cuentas/:codigo',    verifyToken, requireFunc('ctb_plan'), ctrl.editarCuenta);
router.delete('/cuentas/:codigo', verifyToken, requireFunc('ctb_plan'), ctrl.eliminarCuenta);

// Comprobantes
router.get('/comprobantes',            verifyToken, requireFunc('ctb_comprobantes', 'ctb_libros'), ctrl.listarComprobantes);
router.post('/comprobantes',           verifyToken, requireFunc('ctb_comprobantes'), ctrl.crearComprobante);
router.get('/comprobantes/:id',        verifyToken, requireFunc('ctb_comprobantes', 'ctb_libros'), ctrl.getComprobante);
router.post('/comprobantes/:id/anular', verifyToken, requireFunc('ctb_comprobantes'), ctrl.anularComprobante);

// Reglas de centralización (Fase 2)
router.get('/reglas',            verifyToken, requireFunc('ctb_reglas'), ctrl.getReglas);
router.put('/reglas/:evento',    verifyToken, requireFunc('ctb_reglas'), ctrl.putRegla);
router.get('/eventos-log',       verifyToken, requireFunc('ctb_reglas', 'ctb_libros'), ctrl.getEventosLog);

// Libros y balance
router.get('/libro-diario', verifyToken, requireFunc('ctb_libros', 'ctb_balance'), ctrl.libroDiario);
router.get('/libro-mayor',  verifyToken, requireFunc('ctb_libros', 'ctb_balance'), ctrl.libroMayor);
router.get('/balance',      verifyToken, requireFunc('ctb_balance', 'ctb_libros'), ctrl.balance);
router.get('/balance-general',   verifyToken, requireFunc('ctb_estados', 'ctb_balance', 'ctb_libros'), ctrl.balanceGeneral);
router.get('/estado-resultados', verifyToken, requireFunc('ctb_estados', 'ctb_balance', 'ctb_libros'), ctrl.estadoResultados);

module.exports = router;
