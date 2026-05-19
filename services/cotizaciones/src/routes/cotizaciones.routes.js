const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { create, getAll, getByRut } = require('../controllers/cotizaciones.controller');

router.use(verifyToken);
router.post('/',           create);
router.get('/',            getAll);
router.get('/rut/:rut',    getByRut);

module.exports = router;
