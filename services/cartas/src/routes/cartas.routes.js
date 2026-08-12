'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/cartas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',  verifyToken, ctrl.getAll);
router.post('/', verifyToken, requireFunc('aprob_crear', 'aprob_revisar'), ctrl.upsert);   // create o update según body.id

// Vigencia configurable de la carta (días corridos). Lectura abierta; edición = mantenedor.
// Detalle mensual con datos del vendedor (RUT y correo) — controller propio.
router.get('/detalle-mes', verifyToken, requireFunc('aprob_detalle_mes', 'aprob_informes'),
  require('../controllers/detalle-mes.controller').detalleMes);

router.get('/vigencia', verifyToken, ctrl.getVigencia);
router.put('/vigencia', verifyToken, requireFunc('aprob_mantenedor'), ctrl.setVigencia);

// Rentabilidad de la carta (tier UAC vigente). Acceso restringido.
router.get('/:id/rentabilidad', verifyToken, requireFunc('aprob_rentabilidad'), ctrl.rentabilidadTier);

// Ficha completa: todo lo digitado al crear la carta (la impresa muestra solo lo del dealer).
// Solo lectura, para quien crea, revisa o gestiona cartas vigentes.
router.get('/:id/ficha', verifyToken, requireFunc('aprob_crear', 'aprob_revisar', 'aprob_vigentes'), ctrl.fichaCompleta);

// Cartas de Aprobación Vigentes: otorgar (→ crédito OTORGADO + cartola) o desistir (→ DESISTIDA)
router.post('/:id/verificable', verifyToken, requireFunc('aprob_crear', 'aprob_revisar', 'aprob_vigentes'), ctrl.verificable);
router.post('/:id/otorgar',  verifyToken, requireFunc('aprob_vigentes'), ctrl.otorgar);
// Corregir dealer de una carta APROBADA — casilla propia (default solo Admin), motivo obligatorio, auditado
router.put('/:id/corregir-dealer', verifyToken, requireFunc('aprob_corregir_dealer'), ctrl.corregirDealer);
router.post('/:id/desistir', verifyToken, requireFunc('aprob_vigentes'), ctrl.desistir);
router.post('/carga-masiva', verifyToken, requireFunc('aprob_carga_masiva'), ctrl.cargaMasivaCartas);

// Bitácora del Revisor Automático Unidad (auditoría, solo lectura)
router.get('/revisor-bitacora', verifyToken, requireFunc('aprob_revisar'),
  require('../revisor-unidad').bitacora);

// Documentos Unidad: parseo para autocompletar + almacenamiento para revisión
router.post('/parse-unidad',     verifyToken, requireFunc('aprob_crear', 'aprob_revisar'), ctrl.parseUnidad);
router.post('/parse-autofin',    verifyToken, requireFunc('aprob_crear', 'aprob_revisar'), ctrl.parseAutofin);
router.get('/documentos/:docId', verifyToken, ctrl.verDocumento);
router.post('/:id/documentos',   verifyToken, requireFunc('aprob_crear', 'aprob_revisar'), ctrl.subirDocumento);
router.get('/:id/documentos',    verifyToken, ctrl.listarDocumentos);

module.exports = router;
