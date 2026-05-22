const router = require('express').Router();
const ctrl   = require('../controllers/cierre-caja.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = [verifyToken, requirePerfil('Administrador', 'Gerente', 'Supervisor')];

router.get('/cajeros', ...soloAdmin, ctrl.getCajeros);
router.get('/',        ...soloAdmin, ctrl.getCierre);

module.exports = router;
