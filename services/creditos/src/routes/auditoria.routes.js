const router = require('express').Router();
const ctrl   = require('../controllers/auditoria.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const puede = [verifyToken, requireFunc('creditos_auditoria')];

// Backfill histórico (idempotente)
router.post('/backfill', ...puede, ctrl.backfill);

// Historial por crédito
router.get('/:id_credito', ...puede, ctrl.getByCredito);

module.exports = router;
