'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/fichas.controller');

// Lectura: cualquiera con acceso al módulo (el controller filtra por rol).
router.get('/fichas',            verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.listar);
router.get('/fichas/:id',        verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.obtener);
router.get('/fichas/:id/archivo', verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.verFicha);

// Ejecutivo Comercial: crear, editar, subir ficha firmada, enviar a revisión, eliminar borrador.
router.post('/fichas',           verifyToken, requireFunc('dealer_ficha_crear'), ctrl.crear);
router.put('/fichas/:id',        verifyToken, requireFunc('dealer_ficha_crear'), ctrl.editar);
router.post('/fichas/:id/archivo', verifyToken, requireFunc('dealer_ficha_crear'), ctrl.subirFicha);
router.post('/fichas/:id/enviar', verifyToken, requireFunc('dealer_ficha_crear'), ctrl.enviar);
router.delete('/fichas/:id',     verifyToken, requireFunc('dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.eliminar);

// Analista de Operaciones (pool): tomar, aprobar, rechazar.
router.post('/fichas/:id/tomar',    verifyToken, requireFunc('dealer_ficha_revisar'), ctrl.tomar);
router.post('/fichas/:id/aprobar',  verifyToken, requireFunc('dealer_ficha_revisar'), ctrl.aprobar);
router.post('/fichas/:id/rechazar', verifyToken, requireFunc('dealer_ficha_revisar'), ctrl.rechazar);

module.exports = router;
