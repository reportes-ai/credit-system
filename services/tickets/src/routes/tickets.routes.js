'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/tickets.controller');

// Crear / ver / responder — cualquiera con acceso a Tickets TI (el controller filtra por dueño/TI).
router.get('/motivos',          verifyToken, requireFunc('tickets_ti'), ctrl.motivos);
router.get('/pendientes',       verifyToken, requireFunc('tickets_ti'), ctrl.pendientes);
router.get('/tickets',          verifyToken, requireFunc('tickets_ti'), ctrl.listar);
router.post('/tickets',         verifyToken, requireFunc('tickets_ti'), ctrl.crear);
router.get('/tickets/:id',      verifyToken, requireFunc('tickets_ti'), ctrl.obtener);
router.post('/tickets/:id/mensajes', verifyToken, requireFunc('tickets_ti'), ctrl.comentar);
router.put('/tickets/:id/estado',    verifyToken, requireFunc('ti_atender'), ctrl.cambiarEstado);

// Mantenedor
router.get('/admin/motivos',    verifyToken, requireFunc('tickets_ti_mant'), ctrl.motivosAdmin);
router.post('/admin/motivos',   verifyToken, requireFunc('tickets_ti_mant'), ctrl.guardarMotivo);
router.put('/admin/motivos/:id', verifyToken, requireFunc('tickets_ti_mant'), ctrl.guardarMotivo);
router.delete('/admin/motivos/:id', verifyToken, requireFunc('tickets_ti_mant'), ctrl.eliminarMotivo);
router.get('/admin/config',     verifyToken, requireFunc('tickets_ti_mant'), ctrl.getConfig);
router.put('/admin/config',     verifyToken, requireFunc('tickets_ti_mant'), ctrl.setConfig);

module.exports = router;
