const router = require('express').Router();
const { login, cambiarClave, misPermisos } = require('../controllers/auth.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.post('/login', login);
router.post('/cambiar-clave', verifyToken, cambiarClave);
router.get('/mis-permisos', verifyToken, misPermisos);

module.exports = router;
