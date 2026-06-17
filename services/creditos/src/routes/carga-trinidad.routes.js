const router  = require('express').Router();
const multer  = require('multer');
const ctrl    = require('../controllers/carga-trinidad.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const puede = requireFunc('cm_trinidad');

router.post('/preview',            verifyToken, puede, upload.single('archivo'), ctrl.preview);
router.post('/importar',           verifyToken, puede, upload.single('archivo'), ctrl.importar);
router.post('/reprocesar-estados', verifyToken, puede, ctrl.reprocesarEstados);
// Parseo de carta de aprobación (PDF) para digitar — cualquier usuario autenticado
router.post('/parse-carta',        verifyToken, upload.single('archivo'), ctrl.parseCarta);

module.exports = router;
