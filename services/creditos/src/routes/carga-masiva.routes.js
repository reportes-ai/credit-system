const router  = require('express').Router();
const multer  = require('multer');
const ctrl    = require('../controllers/carga-masiva.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const puede = requireFunc('cm_cargar');

router.post('/preview',           verifyToken, puede, upload.single('archivo'), ctrl.preview);
router.post('/importar',          verifyToken, puede, upload.single('archivo'), ctrl.importar);
router.post('/actualizar',        verifyToken, puede, upload.single('archivo'), ctrl.actualizar);
router.post('/eliminar-por-ops',  verifyToken, puede, ctrl.eliminarPorOps);
router.post('/corregir-mes',      verifyToken, puede, ctrl.corregirMes);

module.exports = router;
