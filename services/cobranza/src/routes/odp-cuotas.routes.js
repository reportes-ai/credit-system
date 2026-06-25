'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/odp-cuotas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Emisión (cobranza / caja) — quien tenga permiso de emitir
router.post('/',              verifyToken, requireFunc('odp_cuotas_emitir'), ctrl.emitir);

// ODP propias del solicitante (cualquiera autenticado ve las suyas)
router.get('/mias',           verifyToken, ctrl.mias);

// Cola de Tesorería — ver y resolver
router.get('/',               verifyToken, requireFunc('odp_cuotas_cola'), ctrl.listar);
router.get('/:id',            verifyToken, ctrl.getById);
router.post('/:id/aprobar',   verifyToken, requireFunc('odp_cuotas_cola'), ctrl.aprobar);
router.post('/:id/rechazar',  verifyToken, requireFunc('odp_cuotas_cola'), ctrl.rechazar);

// Anular: el propio solicitante (o admin)
router.post('/:id/anular',    verifyToken, ctrl.anular);

module.exports = router;
