const router = require('express').Router();
const ctrl = require('../controllers/evaluacion.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/ficha/:rut', verifyToken, ctrl.ficha);

module.exports = router;
