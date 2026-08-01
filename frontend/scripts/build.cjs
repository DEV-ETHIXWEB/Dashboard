'use strict';

const { execSync } = require('child_process');

execSync('tsc -b', { stdio: 'inherit' });
execSync('vite build', { stdio: 'inherit' });
