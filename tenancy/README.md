# Multi-band work (not deployed)

Everything here is on the side branch `claude/peatmoss-tenancy`. Nothing in this folder is deployed by the
existing workflows, and `main` (the live app) is untouched. The app change itself is in `index.html` on this
branch only.

## What is built

| Piece | Where | What it does |
|---|---|---|
| Security rules | `firestore.rules` | Everything a band owns lives under `bands/{id}`. Roles: owner, admin, member. A person whose own subscription lapses (`covered:false`) is locked out of all band content. Charts in a band are the band's (they stay when the person who added them leaves); private charts live in the person's own library (`users/{uid}/charts`). Band gigs, sets and charts are never erased directly: a member "deletes" by stamping `deletedAt` (Recently deleted, 30 days), and only an owner or admin can erase something already in the trash. Mileage is not part of any band: it lives under the person (`users/{uid}/mileageTrips`), so it follows them between bands and survives leaving one. |
| Band functions | `functions/band.js`, `functions/reminders.js`, `functions/trash.js`, `functions/index.js` | `createBand`, `createInvite`, `revokeInvite`, `redeemInvite`, `removeMember`, `setMemberRole`, `transferOwnership`, plus `functions/reminders.js` (gig reminders and new-setlist alerts, band by band, in each band's own time zone) and the daily `purgeTrash` job that erases what has been in Recently deleted for 30 days. Membership is only ever written here (Admin SDK); clients cannot write it. |
| Migration | `migrate/migrate.js` | Copies today's flat collections under `bands/{id}` (mileage goes to each person's own area), translating `deviceId` to `uid`; a chart the live app calls shared (a missing flag counts as shared) becomes the band's, a private one goes to its owner's library. Never changes the originals. Refuses a real project without `--live`. |
| App | `../index.html` | New `Root` (sign-in, band picker, start/join, removed and locked-out screens), band-scoped data layer, Band section in Settings (members, invite codes, roles, hand over, leave), "My charts" library with Share with band, and Settings > Recently deleted. |

## Chart files in file storage

Photos, PDFs and HTML files for band charts, set lists and private library charts are kept in Firebase file storage, not
inside the database entry. The entry keeps the name, key, tempo and a reference (`fileId`, `fileSize`, `fileVersion`); a chart
saved the old way (the whole file in `content`) is still read as before.

| Piece | Where |
|---|---|
| Rules | `storage.rules`: `bands/{band}/files/{id}` for a band's paid-up players (read the member list in Firestore), `users/{uid}/files/{id}` for the owner only. Photos, PDFs and plain text up to 15 MB; HTML is stored as plain text. The app can never erase a band file. |
| App | `../index.html`: "Chart files" block (`uploadChartFile`, `getFileBlob`, `useFileSource`, `prepareChartFile`), `useOfflineCharts`, the Settings "Charts for offline" row. Opened files are kept on the phone (Cache API `gigdash-files-v1`). |
| Clean-up | `functions/files.js`, `functions/trash.js` (`purgeTrash` erases a chart's file with it; `sweepOrphanFiles` erases files nothing points to, after a day), `functions/account.js` (`deleteAccount` erases the person's files and a deleted band's files). |
| Migration | `migrate/migrate.js` moves existing inline photos, PDFs and HTML into storage as it copies (`m-<id>` file ids, safe to re-run; the originals are never touched). On the emulator it needs `FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199`; with `--live` it needs `--bucket <name>`. `--keep-inline` copies charts as they are. |

**Not converted yet:** the band's stage plot (one file in `settings/stagePlot`).

**Cutover steps for file storage** (not done: Storage is not set up on the real project yet):
1. In the Firebase console, enable Storage for the project (needs the Blaze plan, which the project is on). Note the bucket name: it must match
   `storageBucket` in `index.html` and the default bucket the functions use.
2. Deploy `storage.rules` (`firebase deploy --only storage`).
3. Apply the browser-access (CORS) setting so the app can fetch files: `gsutil cors set storage-cors.json gs://<bucket>`.
4. Run the migration with `--bucket <bucket>`; check its `files.moved` count against the number of photo/PDF/HTML charts.
5. Deploy the functions (`purgeTrash` and `deleteAccount` now erase files).

## Tests

```
npm install
npm test        # rules (Firestore + Storage), band functions, files, migration (emulators)
npm run e2e     # the real index.html in a phone-sized browser against the real rules, functions and storage
```

`npm run e2e` needs Playwright available (`require('playwright')`). If your shell forces an outbound proxy (`https_proxy`), run it as `env -u https_proxy -u HTTPS_PROXY npm run e2e`: the Functions emulator registers the set-added trigger over a local call that a proxy can intercept and block. Set `E2E_SHOTS=/some/dir` to save screenshots,
including `FAIL_*.png` if the cutover test fails.

The end-to-end suite fails a test if the app logs any Firestore permission error, so it proves every query and write
the app makes is allowed for that role.

## Cutover order (from the Opus plan, adjusted)

1. Everyone in the band signs in on the **current** live app, so their data is keyed to a real account id.
2. Rehearse on the emulator or a scratch project: `node migrate/migrate.js --project <scratch> --owner <uid> --admins <..> --members <..> --band-name "..." --dry-run`, then for real. Any "orphan" it lists belongs to someone who has not signed in yet.
3. Take a Firestore export (the rollback).
4. Pick a weekday morning, never the week of a gig.
5. Run the migration with `--live`, then deploy `firestore.rules` (replacing the root file), then the band functions
   (merged into `functions/index.js`, including `purgeTrash`), then merge the app change.
6. Verify as a plain member on a phone, not as an admin.
7. Leave the old collections alone for 30 days.

## Must be done before cutover

- Reminders: done (`functions/reminders.js`). `sendGigReminders` and `notifyOnNewSetlist` in `tenancy/functions/index.js`
  replace the live ones of the same name. **Deploy order matters:** run the migration first, then deploy the functions.
  The migration writes every existing set, and the new-set trigger would otherwise announce each as new (it also
  skips a band for an hour after a migration as a safety net).
- Push tokens are not migrated (they have no owner). Each phone turns notifications on again in the new app, so no
  one gets reminders until they do. Tell the band beforehand.
- `googleAuthTokens` stay device-keyed and are not migrated.
- The locked-out screen says to resubscribe, but billing is not built yet.

## Not built yet

Stripe per-person subscriptions, the delete-band function (owner only, would reuse the trash idea), server-side
calendar sync, the shared public schedule page.
