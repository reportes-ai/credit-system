'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/cartas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',  verifyToken, ctrl.getAll);
router.post('/', verifyToken, ctrl.upsert);   // create o update según body.id

// Vigencia configurable de la carta (días corridos). Lectura abierta; edición = mantenedor.
router.get('/vigencia', verifyToken, ctrl.getVigencia);
router.put('/vigencia', verifyToken, requireFunc('aprob_mantenedor'), ctrl.setVigencia);

// Cartas de Aprobación Vigentes: otorgar (→ crédito OTORGADO + cartola) o desistir (→ DESISTIDA)
router.post('/:id/otorgar',  verifyToken, requireFunc('aprob_vigentes'), ctrl.otorgar);
router.post('/:id/desistir', verifyToken, requireFunc('aprob_vigentes'), ctrl.desistir);
router.post('/carga-masiva', verifyToken, requireFunc('aprob_carga_masiva'), ctrl.cargaMasivaCartas);

// Documentos Unidad: parseo para autocompletar + almacenamiento para revisión
router.post('/parse-unidad',     verifyToken, ctrl.parseUnidad);
router.post('/parse-autofin',    verifyToken, ctrl.parseAutofin);
router.get('/documentos/:docId', verifyToken, ctrl.verDocumento);
router.post('/:id/documentos',   verifyToken, ctrl.subirDocumento);
router.get('/:id/documentos',    verifyToken, ctrl.listarDocumentos);

module.exports = router;
