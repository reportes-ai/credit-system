'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/credenciales.controller');

router.get('/',    verifyToken, requireFunc('credenciales'), ctrl.listar);
router.get('/empresa', verifyToken, requireFunc('credenciales'), ctrl.empresaGet);
router.put('/empresa', verifyToken, requireFunc('credenciales'), ctrl.empresaPut);
router.get('/mi-foto', verifyToken, ctrl.miFoto);   // foto propia: cualquier usuario logueado
router.get('/fotos',   verifyToken, ctrl.fotos);    // fotos de todos (para el Directorio): cualquier usuario logueado
router.get('/:id', verifyToken, requireFunc('credenciales'), ctrl.una);
router.put('/:id', verifyToken, requireFunc('credenciales'), ctrl.guardar);

module.exports = router;
