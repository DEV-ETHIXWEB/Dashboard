'use strict';

const { Readable } = require('stream');

function isDriveConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_FOLDER_ID);
}

let driveClient = null;
function getDriveClient() {
  if (driveClient) return driveClient;
  // Required here rather than at the top of the file. `googleapis` is the
  // largest dependency in the tree by a wide margin, and loading it costs a
  // second or more of a cold serverless boot -- a cost every request paid,
  // including the 401 that a signed-out visitor's login page waits on, for a
  // client that only report uploads ever ask for. Nothing here runs until
  // somebody actually files a report to Drive.
  const { google } = require('googleapis');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

async function uploadToDrive({ buffer, filename, mimeType }) {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
  });
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return { driveFileId: res.data.id, driveLink: res.data.webViewLink };
}

module.exports = { isDriveConfigured, uploadToDrive };
