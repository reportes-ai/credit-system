const router  = require('express').Router();
const multer  = require('multer');
const ctrl    = require('../controllers/carga-trinidad.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const soloAdmin = requirePerfil('Administrador');

router.post('/preview',  verifyToken, soloAdmin, upload.single('archivo'), ctrl.preview);
router.post('/importar', verifyToken, soloAdmin, upload.single('archivo'), ctrl.importar);

module.exports = router;
