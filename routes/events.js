'use strict';

/**
 * The live wire between the admin side and the client side.
 *
 * One Server-Sent Events stream per signed-in browser. When an admin uploads a
 * report, moves a ticket, or changes what a client may open, the client's tab
 * hears "reports changed" and refetches through the same guarded endpoint it
 * always uses. No record ever travels down this stream, so the channel adds no
 * new way to read data -- only a faster way to notice it moved.
 *
 * The browser reconnects on its own and polls when the stream cannot be held
 * open (serverless, strict proxies), so nothing here is load-bearing for
 * correctness.
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { parseAllowedPages } = require('../utils/clientPages');
const live = require('../utils/liveBus');

/** Well under the 30s most proxies idle out at. */
const HEARTBEAT_MS = 20_000;

/** A stream is cheap but not free; hang up and let the browser reconnect. */
const MAX_STREAM_MS = 30 * 60 * 1000;

router.get('/', requireAuth, (req, res) => {
  const user = {
    id: req.user.id,
    role: req.user.role,
    allowedPages: parseAllowedPages(req.user.allowedPages),
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers text/event-stream by default, which turns a live stream
    // into a very slow batch job.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const write = (chunk) => {
    if (closed) return;
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  };

  const send = (topic, at) => write(`event: change\ndata: ${JSON.stringify({ topic, at })}\n\n`);

  // Tell the browser how long to wait before reconnecting, then confirm the
  // stream is actually flowing so the UI can say "live" honestly.
  write('retry: 3000\n\n');
  write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

  const unsubscribe = live.subscribe(user, send, () => cleanup(true));

  const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
  const lifetime = setTimeout(() => cleanup(true), MAX_STREAM_MS);

  function cleanup(end = false) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    unsubscribe();
    if (end) {
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    }
  }

  req.on('close', () => cleanup());
  res.on('error', () => cleanup());
});

module.exports = router;
