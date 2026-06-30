'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/liquidez.controller');

const F = 'dealer_plan_liquidez';

// Selector de dealers (activos).
router.get('/dealers-disponibles', verifyToken, requireFunc(F), ctrl.dealersDisponibles);

// Planes (cabecera).
router.get('/planes',          verifyToken, requireFunc(F), ctrl.listar);
router.get('/planes/:id',      verifyToken, requireFunc(F), ctrl.obtener);
router.post('/planes',         verifyToken, requireFunc(F), ctrl.crear);
router.put('/planes/:id',      verifyToken, requireFunc(F), ctrl.editar);

// Documentos de respaldo (contrato / pagaré).
router.post('/planes/:id/documentos',            verifyToken, requireFunc(F), ctrl.subirDocumento);
router.get('/planes/:id/documentos/:docId',      verifyToken, requireFunc(F), ctrl.verDocumento);
router.delete('/planes/:id/documentos/:docId',   verifyToken, requireFunc(F), ctrl.eliminarDocumento);

// Preview de la liquidación del mes (motor único).
router.get('/planes/:id/preview-liquidacion', verifyToken, requireFunc(F), ctrl.previewLiquidacion);

module.exports = router;
