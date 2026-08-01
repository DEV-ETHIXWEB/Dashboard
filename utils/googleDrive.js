'use strict';

const { google } = require('googleapis');
const { Readable } = require('stream');

function isDriveConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_FOLDER_ID);
}

let driveClient = null;
function getDriveClient() {
  if (driveClient) return driveClient;
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
