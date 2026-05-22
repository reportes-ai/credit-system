const router = require('express').Router();
const ctrl   = require('../controllers/auditoria.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

// Solo Administrador (o Gerente si se quiere extender)
router.get(
  '/:id_credito',
  verifyToken,
  requirePerfil('Administrador', 'Gerente'),
  ctrl.getByCredito
);

module.exports = router;
