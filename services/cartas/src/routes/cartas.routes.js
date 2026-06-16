'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/cartas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',  verifyToken, ctrl.getAll);
router.post('/', verifyToken, ctrl.upsert);   // create o update según body.id
router.post('/carga-masiva', verifyToken, requireFunc('aprob_carga_masiva'), ctrl.cargaMasivaCartas);

// Documentos Unidad: parseo para autocompletar + almacenamiento para revisión
router.post('/parse-unidad',     verifyToken, ctrl.parseUnidad);
router.post('/parse-autofin',    verifyToken, ctrl.parseAutofin);
router.get('/documentos/:docId', verifyToken, ctrl.verDocumento);
router.post('/:id/documentos',   verifyToken, ctrl.subirDocumento);
router.get('/:id/documentos',    verifyToken, ctrl.listarDocumentos);

module.exports = router;
