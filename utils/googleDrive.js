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
  /**
   * No `anyone with the link` permission, deliberately.
   *
   * Every report uploaded here used to be shared publicly the moment it was
   * created, and a Drive link is a bearer token: invoices, contracts and
   * performance reports could be opened by whoever the URL reached, forwarded
   * or guessed, with none of the dashboard's own access checks in the way.
   * The file stays private to the service account, and
   * `GET /api/reports/:id/download` streams it to a client who has been
   * checked -- which is the route that was already doing that job for files
   * stored in the database.
   *
   * `webViewLink` is still returned: it is how a member of staff opens the
   * file in Drive, where their own Google account is what grants access.
   */
  return { driveFileId: res.data.id, driveLink: res.data.webViewLink };
}

/**
 * The file's bytes, for streaming to somebody the application has checked.
 *
 * Needed because the file is no longer public: a redirect to `webViewLink`
 * now lands a client on a Google sign-in page for an account that cannot see
 * the file. The download route reads it through the service account instead,
 * having first established that this client owns the report.
 */
async function downloadFromDrive(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data);
}

/**
 * Remove the file as well as the row.
 *
 * Deleting a report used to delete the database row only, so the file stayed
 * in Drive -- and, before the change above, stayed publicly readable to anyone
 * who still had the link. A document a client asked us to delete has to stop
 * existing, not stop being listed.
 *
 * Never throws: a Drive outage must not stop the row from being deleted, and a
 * file that is already gone is the outcome we wanted.
 */
async function deleteFromDrive(fileId) {
  if (!fileId || !isDriveConfigured()) return false;
  try {
    await getDriveClient().files.delete({ fileId });
    return true;
  } catch (err) {
    if (err?.code === 404) return true;
    console.error(`[drive] could not delete ${fileId}: ${err.message}`);
    return false;
  }
}

module.exports = { isDriveConfigured, uploadToDrive, downloadFromDrive, deleteFromDrive };
