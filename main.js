#!/usr/bin/env node

'use strict';

const redroid = require('./src');

if (require.main === module) {
  redroid.main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = redroid;
