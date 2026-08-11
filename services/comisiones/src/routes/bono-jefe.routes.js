const router = require('express').Router();
const ctrl = require('../controllers/bono-jefe.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/bsc',       verifyToken, requireFunc('bono_jefe'), ctrl.getBSC);
router.post('/enviar-informe', verifyToken, requireFunc('bono_jefe'), ctrl.enviarInforme);
router.get('/curva',     verifyToken, requireFunc('bono_jefe_variables'), ctrl.getCurva);
router.get('/variables', verifyToken, requireFunc('bono_jefe_variables'), ctrl.getVariables);
router.put('/variables', verifyToken, requireFunc('bono_jefe_variables'), ctrl.setVariables);
// Bitácora de cambios: solo lectura y con permiso propio (se designa por perfil/usuario).
// No hay ruta de edición ni de borrado — la bitácora es inmutable por diseño.
router.get('/bitacora',     verifyToken, requireFunc('bono_jefe_bitacora'), ctrl.getBitacora);
router.get('/bitacora/:id', verifyToken, requireFunc('bono_jefe_bitacora'), ctrl.getBitacoraDetalle);

module.exports = router;
