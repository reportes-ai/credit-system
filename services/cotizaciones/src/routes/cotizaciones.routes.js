const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { create, getAll } = require('../controllers/cotizaciones.controller');

router.use(verifyToken);
router.post('/', create);
router.get('/',  getAll);

module.exports = router;
