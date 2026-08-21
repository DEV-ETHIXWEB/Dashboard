'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const { isDriveConfigured, uploadToDrive } = require('../utils/googleDrive');
const { requirePage } = require('../utils/clientPages');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(requireAuth);
router.use(requirePage('reports'));

function visibleTo(user, report) {
  if (['admin', 'sales', 'project_manager'].includes(user.role)) return true;
  if (user.role === 'client') return report.clientId === user.id;
  return false;
}

function withoutContent(report) {
  const { contentBase64, ...rest } = report;
  return rest;
}

router.get('/', async (req, res, next) => {
  try {
    let all = await db.all('reports');
   
    if (req.query.clientId && req.user.role === 'admin') {
      all = all.filter((r) => r.clientId === req.query.clientId);
    }
    res.json({ reports: all.filter((r) => visibleTo(req.user, r)).map(withoutContent), driveEnabled: isDriveConfigured() });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), upload.single('file'), async (req, res, next) => {
  try {
    const { clientId, category } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

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

router.get('/:id/download', async (req, res, next) => {
  try {
    const report = await db.find('reports', req.params.id);
    if (!report || !visibleTo(req.user, report)) return res.status(404).json({ error: 'Report not found' });

    if (report.storageType === 'drive' && report.driveLink) {
      return res.redirect(report.driveLink);
    }
    if (!report.contentBase64) return res.status(404).json({ error: 'File content not found' });
    const buffer = Buffer.from(report.contentBase64, 'base64');
    res.setHeader('Content-Type', report.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${report.name}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin', 'project_manager'), async (req, res, next) => {
  try {
    const ok = await db.remove('reports', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Report not found' });
    await audit(req.user.id, 'delete', 'report', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
