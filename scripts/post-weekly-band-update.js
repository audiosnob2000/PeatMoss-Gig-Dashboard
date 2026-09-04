// Run weekly by .github/workflows/weekly-band-update.yml. Summarizes the
// past week's commits to the app itself (index.html / functions) as a
// short Band Message, posted straight to Firestore with the Admin SDK so
// it reuses the existing bandMessages banner + push notification path
// (see notifyOnBandMessage in functions/index.js) — no new UI needed.
const { execSync } = require('child_process');
const admin = require('firebase-admin');

const BAND_MESSAGE_CAP = 2; // must match BAND_MESSAGE_CAP in index.html

function buildSummaryText() {
  const log = execSync(
    'git log --since="7 days ago" --no-merges --pretty=%s -- index.html functions',
    { encoding: 'utf8' }
  );
  const items = log
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^Merge /.test(line))
    .map(line => line.replace(/(\s*\(#\d+\))+$/, ''))
    .slice(0, 5);
  if (!items.length) return null;
  let text = 'New this week: ' + items.join(' • ');
  if (text.length > 320) text = text.slice(0, 317) + '…';
  return text;
}

async function main() {
  const text = buildSummaryText();
  if (!text) {
    console.log('No app changes in the last 7 days — skipping post.');
    return;
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  // Same overflow-pruning the client does in postBandMessage() so this
  // never exceeds the app's own cap on active band messages.
  const snap = await db.collection('bandMessages').get();
  const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  msgs.sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''));
  const overflow = msgs.slice(BAND_MESSAGE_CAP - 1);
  await Promise.all(overflow.map(m => db.collection('bandMessages').doc(m.id).delete()));

  await db.collection('bandMessages').doc().set({ text, postedAt: new Date().toISOString() });
  console.log('Posted weekly band update:', text);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
