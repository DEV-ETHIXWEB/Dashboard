'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();

const { db } = require('../db/setup');
const approvals = require('../utils/approvals');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const {
  isDriveConfigured, uploadToDrive, downloadFromDrive, deleteFromDrive,
} = require('../utils/googleDrive');
const { requirePage } = require('../utils/clientPages');

/**
 * The largest file this application can actually accept.
 *
 * 4MB rather than 15, because the platform is the real limit: Vercel caps a
 * request body at 4.5MB and rejects anything larger before the function is
 * even invoked. Multer allowed 15MB, so a 10MB upload did not fail with this
 * module's sentence -- it failed with a platform 413 carrying HTML, which the
 * browser could not parse as JSON and the page showed as an unexplained
 * error. A limit the product enforces can say what it is; one the platform
 * enforces cannot.
 *
 * Anything larger goes to Google Drive, which is what the Drive integration is
 * for, and the page says so.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

/**
 * Multer's own refusal, turned into a sentence and a status.
 *
 * Without this the limit above throws a MulterError straight into the generic
 * handler, which answers 500 "Something went wrong on the server" -- which is
 * both wrong and useless to somebody who just needs to know their file is too
 * big.
 */
function uploadErrors(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That file is over ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB, which is the most `
          + 'this form can take. Share it from Google Drive instead, or compress it.',
      });
    }
    return res.status(400).json({ error: err.message || 'That file could not be read.' });
  });
}

/**
 * What may be stored as a client document, by type and by extension.
 *
 * There was no list at all: whatever type the uploader claimed was stored and
 * handed back later under that same type. SVG was on the "show it in the page"
 * list, and an SVG is not a picture -- it is a document that can carry script.
 * The content policy header blocks that script today, which made the header the
 * only thing standing between a stored file and code running as whoever opened
 * it. One header away from execution is not a boundary.
 *
 * Reports are documents and pictures of documents. Nothing here can be
 * interpreted as markup or code by a browser.
 */
const ALLOWED_UPLOADS = new Map([
  ['application/pdf', ['.pdf']],
  ['text/plain', ['.txt', '.log']],
  ['text/csv', ['.csv']],
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['application/msword', ['.doc']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.ms-excel', ['.xls']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.ms-powerpoint', ['.ppt']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
]);

/** Every extension any allowed type may wear, so a mislabelled file is caught. */
const ALLOWED_EXTENSIONS = new Set([...ALLOWED_UPLOADS.values()].flat());

/**
 * Both halves have to agree.
 *
 * The declared type has to be on the list, and the filename's extension has to
 * be one that type is allowed to wear -- a `.js` file announced as a PDF fails
 * on the second test even though it passed the first.
 */
/**
 * What each allowed type actually begins with on disk.
 *
 * The declared MIME type and the extension are both things the uploader chose,
 * so checking them against each other checks that somebody was consistent, not
 * that the file is what it says. The avatar route has sniffed the bytes all
 * along; this one did not, so a renamed HTML file sent as application/pdf was
 * stored as a PDF and handed back under that type.
 *
 * Only the formats with a stable signature are listed. A CSV or a plain text
 * file has no magic bytes and cannot be checked this way -- which is fine,
 * because neither is served back as anything a browser will execute.
 */
const MAGIC = new Map([
  ['application/pdf', [[0x25, 0x50, 0x44, 0x46]]], // %PDF
  ['image/png', [[0x89, 0x50, 0x4e, 0x47]]],
  ['image/jpeg', [[0xff, 0xd8, 0xff]]],
  ['image/gif', [[0x47, 0x49, 0x46, 0x38]]],
  ['image/webp', [[0x52, 0x49, 0x46, 0x46]]], // RIFF....WEBP
  // Every modern Office format is a zip. So is an .xlsx full of formulas and
  // an .docx full of nothing, which is as far as a signature can take us.
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', [[0x50, 0x4b, 0x03, 0x04]]],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', [[0x50, 0x4b, 0x03, 0x04]]],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', [[0x50, 0x4b, 0x03, 0x04]]],
  // The pre-2007 formats share one compound-document header.
  ['application/msword', [[0xd0, 0xcf, 0x11, 0xe0]]],
  ['application/vnd.ms-excel', [[0xd0, 0xcf, 0x11, 0xe0]]],
  ['application/vnd.ms-powerpoint', [[0xd0, 0xcf, 0x11, 0xe0]]],
]);

/** Whether the bytes agree with the type the upload claims to be. */
function bytesMatchType(buffer, mimeType) {
  const signatures = MAGIC.get(mimeType);
  if (!signatures) return true; // nothing to check against; see the note above
  if (!buffer || buffer.length < 4) return false;
  return signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
}

function uploadRejection(file) {
  const mimeType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  const allowedExtensions = ALLOWED_UPLOADS.get(mimeType);
  if (!allowedExtensions) {
    return `Files of type ${mimeType || 'unknown'} cannot be stored as documents. Allowed: PDF, images, plain text, CSV, Word, Excel and PowerPoint.`;
  }
  const name = String(file.originalname || '');
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
    return `"${name}" does not have a recognised document extension.`;
  }
  if (!allowedExtensions.includes(extension)) {
    return `"${name}" is named ${extension} but was sent as ${mimeType}. The two have to match.`;
  }
  // And the file itself has to agree with both of them.
  if (!bytesMatchType(file.buffer, mimeType)) {
    return `"${name}" is not really a ${mimeType} file. Its contents do not match what it says it is.`;
  }
  return null;
}

router.use(requireAuth);
router.use(requirePage('reports'));

function visibleTo(user, report) {
  if (['admin', 'sales', 'project_manager'].includes(user.role)) return true;
  if (user.role === 'client') return report.clientId === user.id;
  return false;
}

/**
 * The monthly performance report, which only Unlimited includes.
 *
 * Matched on the category rather than on a flag, which is what the upload form
 * and the client's own panel both key off. Case-insensitive so a label typed
 * with a capital M by one admin and a small one by the next is still the same
 * entitlement.
 */
const MONTHLY_REPORT_CATEGORY = 'monthly report';

function isMonthlyReport(report) {
  return String(report?.category || '').trim().toLowerCase() === MONTHLY_REPORT_CATEGORY;
}

/**
 * Whether this client's plan includes the monthly report.
 *
 * The locked panel on the Documents page was the whole of this rule, and a
 * panel is a picture: the reports were in the list the API returned and the
 * file was one `GET /api/reports/:id/download` away, so a Managed client who
 * opened the network tab -- or simply kept a link somebody had sent them --
 * had the Unlimited deliverable. A perk sold on one plan has to be refused on
 * the others by the server, or it is not a perk, it is a CSS rule.
 *
 * Staff are never gated: they are running the workspace, not buying it.
 */
async function maySeeMonthlyReports(user) {
  if (user.role !== 'client') return true;
  try {
    const subscriptions = require('../utils/subscriptions');
    const state = await subscriptions.stateFor(user);
    return subscriptions.has(state, 'monthly_report');
  } catch (err) {
    // An unreadable membership must not hand out the perk. It also must not
    // break the page, so the rest of the documents list is unaffected.
    console.error(`[reports] could not read the plan for ${user.id}: ${err.message}`);
    return false;
  }
}

/**
 * Everything the documents list shows, and nothing else.
 *
 * Named rather than implied, because the thing being left out is the point:
 * `content_base64` holds the whole file, up to 4MB a row, and the list used to
 * read every one of them out of the database in order to print a column of
 * names. On a workspace with a few hundred documents that is hundreds of
 * megabytes crossing the wire to render a table.
 *
 * `size_bytes` is what tells the page whether a database-stored row has a file
 * behind it, which is the one thing the contents were being read for.
 */
const LIST_COLUMNS = [
  'clientId', 'name', 'category', 'storageType', 'driveFileId', 'driveLink',
  'mimeType', 'sizeBytes', 'uploadedBy', 'createdAt',
];

function withoutContent(report) {
  const { contentBase64, ...rest } = report;
  // The bytes never go out with the list, but whether there ARE bytes has to:
  // a row whose file is missing should say so on the page, not hand the viewer
  // a 404 to render as a browser error. Read from the size when the contents
  // were never fetched, and from the contents when they were.
  rest.hasFile = report.storageType === 'drive'
    ? Boolean(report.driveFileId || report.driveLink)
    : Boolean(contentBase64 || Number(report.sizeBytes || 0) > 0);
  return rest;
}

router.get('/', async (req, res, next) => {
  try {
    // Metadata only. See LIST_COLUMNS: the file contents are not something a
    // list of file names has any use for.
    const all = req.query.clientId && req.user.role === 'admin'
      ? await db.where('reports', { clientId: req.query.clientId }, { select: LIST_COLUMNS })
      : req.user.role === 'client'
        ? await db.where('reports', { clientId: req.user.id }, { select: LIST_COLUMNS })
        : await db.where('reports', {}, { select: LIST_COLUMNS });

    // The monthly report is an Unlimited perk, so a client on anything else
    // does not receive the rows. The panel that shows it locked is driven by
    // the entitlement in /api/membership/status, not by these.
    const monthly = await maySeeMonthlyReports(req.user);
    const visible = all
      .filter((r) => visibleTo(req.user, r))
      .filter((r) => monthly || !isMonthlyReport(r));

    res.json({ reports: visible.map(withoutContent), driveEnabled: isDriveConfigured() });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), uploadErrors, async (req, res, next) => {
  try {
    const { clientId, category } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rejection = uploadRejection(req.file);
    if (rejection) return res.status(415).json({ error: rejection });

    const client = await db.find('users', clientId);
    if (!client || client.role !== 'client') return res.status(400).json({ error: 'That is not a client account.' });

    let reportData = {
      clientId, name: req.body.name || req.file.originalname, category: category || 'General',
      mimeType: req.file.mimetype, sizeBytes: req.file.size, uploadedBy: req.user.id,
      createdAt: new Date().toISOString(),
    };

    if (isDriveConfigured()) {
      const { driveFileId, driveLink } = await uploadToDrive({
        buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype,
      });
      reportData = { ...reportData, storageType: 'drive', driveFileId, driveLink };
    } else {
      if (req.file.size > 4 * 1024 * 1024) {
        return res.status(413).json({
          error: 'Files over 4MB need Google Drive storage configured first (see README). Database storage is a fallback with limited capacity.',
        });
      }
      reportData = { ...reportData, storageType: 'database', contentBase64: req.file.buffer.toString('base64') };
    }

    const report = await db.insert('reports', reportData);
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [clientId];
    await audit(req.user.id, 'create', 'report', report.id);
    await notify(clientId, `New report available: "${reportData.name}"`, 'report');
    res.status(201).json({ report: withoutContent(report) });
  } catch (err) {
    next(err);
  }
});

/**
 * Types a browser can render itself. Anything else is handed over as a file,
 * because a .docx streamed inline is a page of mojibake rather than a document.
 */
const VIEWABLE = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** A filename safe to put in a header: no quotes, no newlines, no path. */
function headerFilename(name) {
  return String(name || 'document').replace(/[\r\n"\\]/g, '').replace(/[/\\]/g, '-').slice(0, 200);
}

/**
 * Open or download one document.
 *
 * `?disposition=inline` asks the browser to *show* it rather than save it,
 * which is what "Open" means to everybody outside this codebase. Without it a
 * new tab opens, immediately downloads, and closes again -- which reads as
 * nothing happening at all.
 *
 * Only formats a browser can actually render are served inline; a Word file
 * still arrives as a file whatever the link asks for. `X-Content-Type-Options:
 * nosniff` is already set globally, so a mislabelled upload cannot be coaxed
 * into executing as something else.
 */
router.get('/:id/download', async (req, res, next) => {
  try {
    const report = await db.find('reports', req.params.id);
    if (!report || !visibleTo(req.user, report)) return res.status(404).json({ error: 'Report not found' });

    // The same rule as the list, on the door the file actually comes out of.
    // Filtering the list alone would leave the download reachable by anybody
    // who had a link, which is where a locked panel stops being a gate.
    if (isMonthlyReport(report) && !(await maySeeMonthlyReports(req.user))) {
      return res.status(403).json({
        error: 'The monthly performance report is included with the Unlimited plan.',
        upgradeRequired: true,
        recommended: 'unlimited',
      });
    }

    /**
     * A file in Drive is read through the service account and streamed back,
     * not redirected to.
     *
     * This used to send the client to `webViewLink`, which worked because
     * every upload was shared "anyone with the link: reader" -- so the link
     * was the access control, and anybody it reached could open an invoice or
     * a contract without ever touching this application. The files are private
     * now, and the ownership check a few lines above is what grants access.
     */
    let buffer = null;
    if (report.storageType === 'drive') {
      if (!report.driveFileId) return res.status(404).json({ error: 'File content not found' });
      try {
        buffer = await downloadFromDrive(report.driveFileId);
      } catch (err) {
        console.error(`[reports] could not read ${report.driveFileId} from Drive: ${err.message}`);
        return res.status(502).json({ error: 'That file could not be fetched from storage.' });
      }
    } else {
      if (!report.contentBase64) return res.status(404).json({ error: 'File content not found' });
      buffer = Buffer.from(report.contentBase64, 'base64');
    }

    const declared = String(report.mimeType || '').split(';')[0].trim().toLowerCase();
    // Rows uploaded before the allowlist existed may carry any type at all.
    // Serving one back under its own label is what would make a stored SVG or
    // HTML file execute in the app's own origin, so anything unrecognised goes
    // out as a neutral download instead.
    const mimeType = ALLOWED_UPLOADS.has(declared) ? declared : 'application/octet-stream';
    const wantsInline = req.query.disposition === 'inline' && VIEWABLE.includes(mimeType);

    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `${wantsInline ? 'inline' : 'attachment'}; filename="${headerFilename(report.name)}"`,
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin', 'project_manager'), async (req, res, next) => {
  try {
    const report = await db.find('reports', req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const gate = await approvals.gate(req, res, {
      action: 'report.delete',
      summary: `Delete the document "${report.name}"`,
      payload: { reportId: req.params.id },
    });
    if (gate.held) return;

    const ok = await db.remove('reports', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Report not found' });

    // And the file itself. Deleting the row alone left the document in Drive,
    // which before these files were made private meant a deleted invoice was
    // still readable by anybody holding the link. A document somebody asked us
    // to delete has to stop existing, not stop being listed. Best-effort and
    // after the row, so a Drive outage cannot block the deletion.
    if (report.storageType === 'drive' && report.driveFileId) {
      await deleteFromDrive(report.driveFileId);
    }

    await audit(req.user.id, 'delete', 'report', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
