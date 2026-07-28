'use strict';

// Builds the React frontend (./frontend, a subfolder of this repo) and
// copies its production output into public/, replacing the previous
// contents. This is what makes `public/` -- already served by
// express.static() in server.js, and already what vercel.json points
// non-API requests at -- serve the SPA.
//
// Run manually with `npm run build`, or automatically by Vercel during
// deployment (see the "buildCommand" in vercel.json).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_DIR = path.join(FRONTEND_DIR, 'dist');

if (!fs.existsSync(FRONTEND_DIR)) {
  // frontend/ is a real part of this repo, so this should only happen if
  // something deleted it, or a deployment's Root Directory setting is
  // scoped narrower than the repo root. Either way, if public/ already has
  // a working build committed, fall back to serving that instead of
  // failing the whole deployment.
  const hasExistingBuild = fs.existsSync(PUBLIC_DIR) && fs.readdirSync(PUBLIC_DIR).length > 0;
  if (hasExistingBuild) {
    console.warn(`frontend/ not found at ${FRONTEND_DIR} -- skipping rebuild and keeping the existing public/ output.`);
    process.exit(0);
  }
  console.error(`frontend/ not found at ${FRONTEND_DIR}, and public/ has no existing build to fall back on.`);
  process.exit(1);
}

console.log(`Building frontend from ${FRONTEND_DIR} ...`);
// Two separate calls (not "npm install && npm run build") so this works
// regardless of the default shell -- older Windows PowerShell doesn't
// support "&&" as a statement separator.
execSync('npm install', { cwd: FRONTEND_DIR, stdio: 'inherit' });
execSync('npm run build', { cwd: FRONTEND_DIR, stdio: 'inherit' });

if (!fs.existsSync(DIST_DIR)) {
  console.error(`Frontend build did not produce a dist/ folder at ${DIST_DIR}`);
  process.exit(1);
}

console.log('Copying frontend build into public/ ...');
fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
fs.cpSync(DIST_DIR, PUBLIC_DIR, { recursive: true });

console.log('Done. public/ now serves the built frontend.');
