'use strict';

const net = require('net');

const PORT = Number(process.env.BACKEND_PORT || 4000);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 120_000;
const RETRY_MS = 400;

function probe() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: HOST });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

(async () => {
  const startedAt = Date.now();
  let announced = false;

  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (await probe()) {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[wait-for-backend] backend is up on ${HOST}:${PORT} (waited ${secs}s)`);
      process.exit(0);
    }
    if (!announced) {
      console.log(`[wait-for-backend] waiting for the backend on ${HOST}:${PORT}...`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }

  console.error(
    `[wait-for-backend] backend did not come up on ${HOST}:${PORT} within ${TIMEOUT_MS / 1000}s.\n` +
      '  Check the [backend] output above for the real error (a bad DATABASE_URL is the usual cause).',
  );
  process.exit(1);
})();
