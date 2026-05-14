const router = require('express').Router();
const ctrl = require('../controllers/usuarios.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

router.get('/', verifyToken, ctrl.getAllUsuarios);
router.get('/:id', verifyToken, ctrl.getUsuarioById);
router.post('/', verifyToken, soloAdmin, ctrl.createUsuario);
router.put('/:id', verifyToken, soloAdmin, ctrl.updateUsuario);
router.delete('/:id', verifyToken, soloAdmin, ctrl.deleteUsuario);
router.post('/:id/reset-clave', verifyToken, soloAdmin, ctrl.resetClave);

module.exports = router;
