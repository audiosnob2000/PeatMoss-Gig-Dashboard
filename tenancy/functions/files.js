'use strict';
// Chart files in file storage (see storage.rules). The database entry for a chart or set list holds a reference (fileId); the
// file itself is at bands/{band}/files/{fileId} (band charts, set lists) or users/{uid}/files/{fileId} (a person's private
// library). The app never erases a band file (the storage rules forbid it); the daily clean-up job and account deletion do,
// with the Admin SDK. This module is the small seam between that code and a storage bucket, so it can be tested with a stand-in.

// A bucket (admin.storage().bucket()) as { remove, removePrefix, list }.
function makeStorageFiles(bucket) {
  return {
    remove: path => bucket.file(path).delete({ ignoreNotFound: true }),
    removePrefix: prefix => bucket.deleteFiles({ prefix, force: true }),
    put: (path, buffer, contentType) => bucket.file(path).save(buffer, { contentType, resumable: false }),
    size: async path => Number((await bucket.file(path).getMetadata())[0].size),
    list: async prefix => {
      const [files] = await bucket.getFiles({ prefix });
      return files.map(f => ({ path: f.name, createdMs: Date.parse((f.metadata && (f.metadata.timeCreated || f.metadata.updated)) || '') || 0 }));
    },
  };
}

// A chart saved the old way keeps its whole file inside the entry: a photo or PDF as a data: address, HTML as text. Returns
// {buffer, contentType} ready to store as a file (HTML goes in as plain text, as the app does), or null if there is nothing to decode.
function decodeInline(d) {
  if (!d || typeof d.content !== 'string') return null;
  if (d.type === 'html') return { buffer: Buffer.from(d.content, 'utf8'), contentType: 'text/plain' };
  const m = d.content.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
  if (!m) return null;
  return { buffer: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8'), contentType: m[1] || 'application/octet-stream' };
}
const hasInlineFile = d => !!d && ['image', 'file', 'html'].includes(d.type) && !d.fileId && typeof d.content === 'string';

const bandFilePath = (bandId, fileId) => `bands/${bandId}/files/${fileId}`;
const userFilePath = (uid, fileId) => `users/${uid}/files/${fileId}`;

module.exports = { makeStorageFiles, decodeInline, hasInlineFile, bandFilePath, userFilePath };
