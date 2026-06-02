const router = require('express').Router();
const ctrl   = require('../controllers/comisiones.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

router.get('/variables',          verifyToken,            ctrl.getVariables);
router.put('/variables',          verifyToken, soloAdmin, ctrl.putVariables);
router.get('/calculo',            verifyToken,            ctrl.getCalculo);
router.get('/ejecutivos',         verifyToken,            ctrl.getEjecutivos);
router.post('/aprobar',           verifyToken, soloAdmin, ctrl.aprobar);

module.exports = router;
