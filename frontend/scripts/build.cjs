'use strict';

// Runs the type-check + bundle steps as two separate child processes
// instead of "tsc -b && vite build" in a single shell string. "&&" isn't
// supported by every shell npm might use to run scripts (notably Windows
// PowerShell 5.1) -- this way the build works the same everywhere, and
// still stops before bundling if the type-check fails.

const { execSync } = require('child_process');

execSync('tsc -b', { stdio: 'inherit' });
execSync('vite build', { stdio: 'inherit' });
