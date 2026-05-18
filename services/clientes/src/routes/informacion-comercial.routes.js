const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/informacion-comercial.controller');

router.get('/:rut', verifyToken, ctrl.getByRut);
router.put('/:rut', verifyToken, ctrl.upsert);

module.exports = router;
