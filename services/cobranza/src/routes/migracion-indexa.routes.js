const router = require('express').Router();
const multer = require('multer');
const ctrl   = require('../controllers/migracion-indexa.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// El .txt crudo de cobranza pesa ~12MB; holgura a 30MB por archivo.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const dos = upload.fields([{ name: 'desarrollo', maxCount: 1 }, { name: 'cobranza', maxCount: 1 }]);
// Acción de migración: solo perfiles con el permiso (Admin pasa por bypass).
const puede = requireFunc('cobranza_migracion_indexa');

router.post('/dry-run',       verifyToken, puede, dos, ctrl.dryRun);
router.post('/aplicar-init',  verifyToken, puede, dos, ctrl.aplicarInit);   // sube 2 archivos, deja el job listo
router.post('/aplicar-chunk', verifyToken, puede, ctrl.aplicarChunk);       // procesa un tramo (JSON)

module.exports = router;
