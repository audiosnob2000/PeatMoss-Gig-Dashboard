'use strict';
// Operator tool: mark a band complimentary (never charged, never locked) or remove the mark.
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node scripts/set-complimentary.js --project demo-x <bandId> on|off
//   (real project: add --live; needs Admin credentials). Users cannot do this: the rules forbid it.
const admin = require('../functions/node_modules/firebase-admin');
const { enforceCoverage } = require('../functions/billing');

(async () => {
  const args = process.argv.slice(2);
  const project = args[args.indexOf('--project') + 1];
  const [bandId, mode] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--project');
  if (!project || !bandId || !['on', 'off'].includes(mode)) throw new Error('Usage: set-complimentary.js --project <id> [--live] <bandId> on|off');
  if (!process.env.FIRESTORE_EMULATOR_HOST && !args.includes('--live')) throw new Error('No emulator set; add --live to change a real project.');
  admin.initializeApp({ projectId: project });
  const db = admin.firestore();
  const ref = db.collection('bands').doc(bandId);
  if (!(await ref.get()).exists) throw new Error(`bands/${bandId} not found.`);
  await ref.update({ 'billing.complimentary': mode === 'on' });
  console.log(`bands/${bandId}: complimentary ${mode}`, JSON.stringify(await enforceCoverage(db)));
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
