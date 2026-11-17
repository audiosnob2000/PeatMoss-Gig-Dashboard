# Multi-band work (not deployed)

Everything here is on the side branch `claude/peatmoss-tenancy`. Nothing in this folder is deployed by the
existing workflows, and `main` (the live app) is untouched. The app change itself is in `index.html` on this
branch only.

## What is built

| Piece | Where | What it does |
|---|---|---|
| Security rules | `firestore.rules` | Everything a band owns lives under `bands/{id}`. Roles: owner, admin, member. A person whose own subscription lapses (`covered:false`) is locked out of all band content. Private charts are enforced by the rules, not by hiding them. Mileage is not part of any band: it lives under the person (`users/{uid}/mileageTrips`), so it follows them between bands and survives leaving one. |
| Band functions | `functions/band.js`, `functions/index.js` | `createBand`, `createInvite`, `revokeInvite`, `redeemInvite`, `removeMember`, `setMemberRole`, `transferOwnership`. Membership is only ever written here (Admin SDK); clients cannot write it. |
| Migration | `migrate/migrate.js` | Copies today's flat collections under `bands/{id}` (mileage goes to each person's own area), translating `deviceId` to `uid` and a missing `shared` flag to `shared:true`. Never changes the originals. Refuses a real project without `--live`. |
| App | `../index.html` | New `Root` (sign-in, band picker, start/join, removed and locked-out screens), band-scoped data layer, Band section in Settings (members, invite codes, roles, hand over, leave). |

## Tests

```
npm install
npm test        # 62: rules, band functions, migration (Firestore emulator)
npm run e2e     # 18: the real index.html in a phone-sized browser against the real rules and functions
```

`npm run e2e` needs Playwright available (`require('playwright')`). Set `E2E_SHOTS=/some/dir` to save screenshots,
including `FAIL_*.png` if the cutover test fails.

The end-to-end suite fails a test if the app logs any Firestore permission error, so it proves every query and write
the app makes is allowed for that role.

## Cutover order (from the Opus plan, adjusted)

1. Everyone in the band signs in on the **current** live app, so their data is keyed to a real account id.
2. Rehearse on the emulator or a scratch project: `node migrate/migrate.js --project <scratch> --owner <uid> --admins <..> --members <..> --band-name "..." --dry-run`, then for real. Any "orphan" it lists belongs to someone who has not signed in yet.
3. Take a Firestore export (the rollback).
4. Pick a weekday morning, never the week of a gig.
5. Run the migration with `--live`, then deploy `firestore.rules` (replacing the root file), then the band functions
   (merged into `functions/index.js`), then merge the app change.
6. Verify as a plain member on a phone, not as an admin.
7. Leave the old collections alone for 30 days.

## Must be done before cutover

- `sendGigReminders` and `notifyOnNewSetlist` in the live `functions/index.js` still read the flat `gigs`, `setlists`,
  `fcmTokens` and `bandSettings` paths. They need to read `bands/{id}/...`.
- Push tokens are not migrated (they have no owner). Each phone turns notifications on again in the new app.
- `googleAuthTokens` stay device-keyed and are not migrated.
- The locked-out screen says to resubscribe, but billing is not built yet.

## Not built yet

Stripe per-person subscriptions, trash and the delete-band function (owner only), server-side calendar sync, a
"download my mileage" step when leaving a band, the shared public schedule page.
