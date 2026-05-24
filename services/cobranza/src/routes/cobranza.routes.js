'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/cobranza.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

// Rutas estáticas primero
router.get('/dashboard',              verifyToken, ctrl.dashboard);
router.get('/cartera',                verifyToken, ctrl.cartera);
router.get('/provisiones',            verifyToken, ctrl.provisiones);
router.get('/mis-gestiones',          verifyToken, ctrl.misGestiones);
router.post('/gestiones',             verifyToken, ctrl.crearGestion);
router.put('/gestiones/:id/confirmar',verifyToken, ctrl.confirmarGestion);

// Rutas con parámetro al final
router.get('/disponibilidad/:id_credito', verifyToken, ctrl.disponibilidad);
router.get('/mensajes/:id_credito',       verifyToken, ctrl.mensajes);
router.get('/bitacora/:id_credito',       verifyToken, ctrl.bitacora);

module.exports = router;
