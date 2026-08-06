const router = require('express').Router();
const { login, cambiarClave, misPermisos, verComo } = require('../controllers/auth.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.post('/login', login);
router.post('/cambiar-clave', verifyToken, cambiarClave);
router.get('/mis-permisos', verifyToken, misPermisos);
router.post('/ver-como', verifyToken, requireFunc('usuarios_ver_como'), verComo);

module.exports = router;
