'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_DIR = path.join(FRONTEND_DIR, 'dist');

if (!fs.existsSync(FRONTEND_DIR)) {
  const hasExistingBuild = fs.existsSync(PUBLIC_DIR) && fs.readdirSync(PUBLIC_DIR).length > 0;
  if (hasExistingBuild) {
    console.warn(`frontend/ not found at ${FRONTEND_DIR} -- skipping rebuild and keeping the existing public/ output.`);
    process.exit(0);
  }
  console.error(`frontend/ not found at ${FRONTEND_DIR}, and public/ has no existing build to fall back on.`);
  process.exit(1);
}

console.log(`Building frontend from ${FRONTEND_DIR} ...`);
// --include=dev because the host sets NODE_ENV=production for the build, and
// npm then omits devDependencies -- which is where vite, the react plugin and
// typescript live. Without them `tsc -b` cannot resolve its own config and the
// build dies on "Cannot find module 'vite'".
execSync('npm install --include=dev', { cwd: FRONTEND_DIR, stdio: 'inherit' });
execSync('npm run build', { cwd: FRONTEND_DIR, stdio: 'inherit' });

if (!fs.existsSync(DIST_DIR)) {
  console.error(`Frontend build did not produce a dist/ folder at ${DIST_DIR}`);
  process.exit(1);
}

console.log('Copying frontend build into public/ ...');
fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
fs.cpSync(DIST_DIR, PUBLIC_DIR, { recursive: true });

console.log('Done. public/ now serves the built frontend.');
