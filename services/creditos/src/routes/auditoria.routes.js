const router = require('express').Router();
const ctrl   = require('../controllers/auditoria.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = [verifyToken, requirePerfil('Administrador', 'Gerente')];

// Backfill histórico (idempotente)
router.post('/backfill', ...soloAdmin, ctrl.backfill);

// Historial por crédito
router.get('/:id_credito', ...soloAdmin, ctrl.getByCredito);

module.exports = router;
