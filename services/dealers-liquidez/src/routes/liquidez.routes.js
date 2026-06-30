'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/liquidez.controller');
const hojas = require('../controllers/hojas.controller');

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

/* ── Hoja de Liquidación mensual + cadena de aprobación ────────────────────── */
// Lectura: cualquiera con acceso al módulo (Admin + niveles).
router.get('/hojas',         verifyToken, requireFunc(F, 'liquidez_hoja_gestionar', 'liquidez_aprob_n1', 'liquidez_aprob_n2', 'liquidez_n3_conocimiento'), hojas.listarHojas);
router.get('/hojas/:id',     verifyToken, requireFunc(F, 'liquidez_hoja_gestionar', 'liquidez_aprob_n1', 'liquidez_aprob_n2', 'liquidez_n3_conocimiento'), hojas.obtenerHoja);
// Generar / enviar a la cadena.
router.post('/hojas/generar',     verifyToken, requireFunc('liquidez_hoja_gestionar'), hojas.generarHoja);
router.post('/hojas/:id/enviar',  verifyToken, requireFunc('liquidez_hoja_gestionar'), hojas.enviarHoja);
// Aprobar / modificar / conocimiento — validan el permiso del nivel actual dentro del controller.
router.put('/hojas/:id/lineas/:lid', verifyToken, hojas.modificarLinea);
router.post('/hojas/:id/aprobar',    verifyToken, hojas.aprobarHoja);
router.post('/hojas/:id/conocimiento', verifyToken, hojas.conocimientoHoja);
// Emisión de las Órdenes de Pago de una hoja aprobada.
router.post('/hojas/:id/emitir-odp', verifyToken, requireFunc('liquidez_hoja_gestionar'), hojas.emitirOdp);

module.exports = router;
