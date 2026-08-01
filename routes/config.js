'use strict';

const express = require('express');
const router = express.Router();
const { getPublicConfig } = require('../config');

router.get('/', (req, res) => {
  res.json(getPublicConfig());
});

module.exports = router;
