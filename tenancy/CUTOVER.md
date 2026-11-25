# Cutover runbook: from the live single-band app to the multi-band app

**Status: prepared, rehearsed locally, NOT done. No launch date is set.** Nothing in this document has been run against the real
Firebase project. Everything below was rehearsed on the local emulators (`npm run rehearse`, 11 checks) and the staging script
(`node scripts/stage-cutover.js`) builds the exact set of files. The practice-project rehearsal (a second Firebase project) is still to do.

## What "cutover" means

Today the band's app reads flat collections (`gigs`, `songs`, ...) that any signed-in person can use. The new app keeps each band's data
under `bands/{id}`, with roles, per-person subscriptions and chart files in file storage. They cannot run side by side on the same rules:
the moment the new rules are live, the old app is locked out, and the new app cannot work on the old rules. So the switch is a short
hard cut (plan on **10 to 20 minutes** when the app is unusable), after a **migration** that copies the band's data into the new layout
**without changing the old data**. The old data stays where it is, which is what makes going back possible.

## Before you pick a day (checklist, all must be true)

Run these from `tenancy/` on the branch that holds the new app. Each should be clean.

| Check | Command | Today |
|---|---|---|
| Rules, functions, files, migration, staging | `npm test` | passes |
| The real app in a phone-sized browser | `npm run e2e` | passes |
| Dress rehearsal on a live-shaped copy of the data | `npm run rehearse` | passes (11 of 11) |
| Staging folder builds, nothing blocks launch | `git fetch origin && node scripts/stage-cutover.js --strict` | **fails: the blockers below** |

Every change made to the live app since the new app branched is also in the new app (the grouped Settings were the last one; there is a test for each).

`stage-cutover.js` writes `tenancy/cutover-staging/` (not committed) with a `MANIFEST.md` that lists the blockers. Today they are:

- **Stripe is in test mode.** `functions/billing-config.json` has test ids. With the LIVE Stripe key, run
  `node scripts/setup-stripe.js --live`, commit the result (it writes `"mode": "live"`). Also do launch-checklist items 1 and 2 in `BILLING.md`
  (reminder emails, live Customer Portal, the three secrets, the webhook).
- **Terms and Privacy pages have blanks** (operator name and address, support email, refund wording, governing law) **and the yellow
  "Draft" box.** `BILLING.md` items 3b to 3d.

Also decide, with people in the loop (none of these are code):

- [ ] The day. A **weekday morning, never the week of a gig**, never New Year's Eve week. Nobody should be mid-edit.
- [ ] Everyone in the band has **signed in on the current live app at least once**, so their data is keyed to a real account and not to a
      device id. The dry run lists anything still owned by a device id ("orphans"). Expect a few old-phone leftovers; you decide whether to
      copy them anyway (`--allow-orphans`) or find their owners.
- [ ] A person with **Firebase project owner** access, and the **GitHub secret `FIREBASE_SERVICE_ACCOUNT`** still valid (the deploys use it).
- [ ] The **practice-project rehearsal** done (see the last section) so the real-service parts are not a first attempt.

## What changes on `main`, and what happens when it merges

Merging the cutover change to `main` triggers three automatic things at the same moment: **GitHub Pages** publishes the new app,
**Deploy Firestore Rules** replaces the rules, and **Deploy Functions** replaces the functions (this one takes a few minutes). The
migration and the Storage setup must therefore be done **before** the merge. That is why the order below matters.

Files replaced or added (the staging folder is the authoritative list):

| File | What |
|---|---|
| `index.html`, `firebase-messaging-sw.js`, `manifest.json`, `vendor/`, `icons/` | the new app (already contains every change made to the live app since) |
| `terms.html`, `privacy.html` | the legal pages (new, linked from sign-up and Settings) |
| `firestore.rules` | **replaces** the live rules with the multi-band rules |
| `storage.rules`, `storage-cors.json` | new: file storage |
| `firebase.json` | the live one plus the storage rules |
| `functions/*` | the new functions merged with the live Google Calendar sign-in endpoints (`exchangeGoogleAuthCode`, `refreshGoogleAuthToken`, `revokeGoogleAuth`, which must keep working); `sendGigReminders` and `notifyOnNewSetlist` are replaced by their band-scoped versions |
| `.github/workflows/` | the two existing deploys, plus **deploy-storage-rules** and **cutover-migration** (manual only) |

## The day, in order

Times are rough. **Stop at any step that does not give the expected result and ask before going on.**

**0. Tell the band (the day before).** Use the message at the end of this file. Ask everyone to open the app once so it is up to date, and to
stop editing at the agreed time.

**1. Back up the database (5 minutes, owner).** In the Google Cloud console for the project: Firestore > Import/Export > Export, to a bucket
you own (`cutover-backup-<date>`). This is the last-resort way back. Write down the bucket and the time.
*(Or: `gcloud firestore export gs://<bucket>/cutover-backup-<date> --project peatmoss-gig-dashboard-4f41b`.)*
**Expect:** an export folder appears. **If not:** stop.

**2. Turn on file storage (owner, 5 minutes). Tell Claude first so the cost is checked.** Firebase console > Build > Storage > Get started,
production mode, location near the project. The project is already on the Blaze plan. **The bucket name must be exactly the one in
`index.html`** (`storageBucket`, shown in `MANIFEST.md`). If it differs, stop: the app and the migration would use different buckets (the
rehearsal caught this once).

**3. Browser access to the bucket (owner, 2 minutes).** Without this the app cannot download charts:
`gsutil cors set tenancy/storage-cors.json gs://<bucket>`. Then run `gsutil cors get gs://<bucket>` and confirm it lists
`https://audiosnob2000.github.io`. If the app is hosted somewhere else, edit the origin in the file first.

**4. Storage rules (owner, 3 minutes).** The very first time, by hand: Firebase console > Storage > Rules, paste `tenancy/storage.rules`, Publish
(or `firebase deploy --only storage` with the Firebase CLI). After the merge, the new **Deploy Storage Rules** workflow deploys any later change; its
service account needs permission for storage rules (role **Firebase Rules Admin** or **Firebase Admin**; if a run says permission denied, add the role
in IAM). **Expect:** the rules page shows the published rules with today's date.

**5. Secrets (owner).** `firebase functions:secrets:set STRIPE_SECRET_KEY` (the **live** key), `STRIPE_WEBHOOK_SECRET` (a placeholder for now),
`RESEND_API_KEY`. Optional: `REPLY_TO_EMAIL`. The functions will not deploy without the three secrets existing. The Resend sender domain must be verified
(`FROM_ADDRESS` in `functions/index.js`).

**6. The migration, dry run (owner or Claude through the workflow).** Start **Actions > Cutover migration > Run workflow** with *dry run = true*.
Fill in the owner, admins and members **uids** (Firebase console > Authentication shows them), the band name and the bucket. **Expect:**
the report lists counts that match what the band has, `files.wouldMove` equal to the number of photo/PDF/HTML charts and set lists, and
possibly "orphans". **If it says `blocked`:** read the orphans. Each belongs to a person not in your list. Add them, or decide to copy them anyway.

**7. The migration, for real.** Same workflow, *dry run = false* (and *allow orphans = true* only if you decided to). **Expect:** `"done": true`,
`files.moved` equal to the dry run's `wouldMove`, and `undecodable` empty. The band document is written last, so a run that died half way changes
nothing visible and can be run again. **The old data is untouched.** Check in the Firebase console: `bands/peat-moss` exists, with `gigs`, `songs`, `members`.

**8. Merge the cutover change (the switch).** Open the pull request prepared from the staging folder (see "Preparing the pull request"), check the
file list against `MANIFEST.md`, and merge. The three automatic deploys start. **Expect:** Pages finishes in a minute or two, rules in seconds,
functions in about five minutes. Watch Actions until all three are green.

**9. Stripe webhook (owner, 10 minutes).** In Stripe (live mode) add the deployed `stripeWebhook` function's URL with the events in `BILLING.md`,
copy its signing secret into `STRIPE_WEBHOOK_SECRET` (`firebase functions:secrets:set`) and redeploy the functions (Actions > Deploy Functions > Run
workflow). Give Stripe the page addresses (`BILLING.md` 3c).

**10. Verify, as a plain member on a real phone, not as an admin (15 minutes).**
- Open the app: sign in, you land in the band (no sign-up or subscribe screen: the founding band is free).
- Gigs, charts (open a photo chart and a PDF), set lists, checklists, mileage, the stage plot, the Google Calendar id: all there.
- Gig Day shows tonight's gig; Mark paid works.
- Turn on notifications (they are **not** carried over), sign in to Google Calendar again (the device tokens are **not** carried over).
- Airplane mode: the app opens; a chart you have opened still opens.
- Then as the owner: invite code, a member joining, billing banner, **Delete my account is NOT to be tested on a real person**.
- Stripe: a real card test with a refund, or a coupon-free checkout in test mode if you want to hold back real money until you are ready.

**11. Leave the old data alone for 30 days.** The old flat collections, old tokens and the backup stay until you have lived on the new app
for a month. After that, a clean-up (not built) can remove them.

## The way back

| When | What to do | What you lose |
|---|---|---|
| Something is wrong in the first hours, before people have added anything in the new app | Revert the cutover change on `main` (GitHub: Revert on the merged pull request, then merge). Pages, the old rules and the old functions redeploy. The old data was never touched, so the old app works exactly as before. The `rehearse` test proves the old rules still serve the old data. | Nothing the band did on the old app. Anything added in the new app in the meantime stays in `bands/...` only and is not copied back. |
| It has been days, people have used the new app | A reverse copy is **not built**. Prefer fixing forward. | Data entered since the cutover would need a manual re-entry or a small script. |
| The database itself is damaged | Restore the export from step 1 (Firestore > Import). | Everything since the export. |
| Real customers have paid | There is no rollback past this point: money has moved. Fix forward; refund through Stripe if needed. | |

The decision point for "this is a rollback day": more than about 30 minutes of the app being unusable, or any sign of a person seeing
another band's data (that is a stop-the-world problem: revert first, investigate after).

## Preparing the pull request (so merge day is just a merge)

1. `git fetch origin` then `node tenancy/scripts/stage-cutover.js --strict` must show **no blockers**.
2. Make a branch **from the latest `origin/main`**, then copy the files in `tenancy/cutover-staging/` over the repo root (same paths; `MANIFEST.md` is not
   copied) and **commit**. Taking the staged files wholesale is right: they already contain every change made to the live app.
3. Compare the pull request's file list with the manifest. Do **not** merge it early, and **do not merge the long-lived `claude/vibrant-gates-...`
   branch itself**: it holds the new app at the repo root as well as the work in `tenancy/`, so merging it is the cutover.
4. `tenancy/` itself (tests, rehearsal, this runbook) can go to `main` with the cutover or after. It is not served by the app.

## The practice project (second rehearsal, not done)

The local rehearsal proves the code. A practice Firebase project proves the real services: that the functions deploy and start, that Google sign-in works with
the new app, that Storage download addresses and the CORS setting work from a browser, that the Stripe webhook and the email arrive. Steps when you are ready:

1. Create a second Firebase project (free), on the Blaze plan with a **budget alert**. Claude states the cost before any click.
2. Enable Authentication (email/password and Google), Firestore, Storage. Apply `storage.rules` and `firestore.rules`, and `storage-cors.json` to its bucket.
3. Put a **copy** of the live data in it (Firestore export from the live project, import into the practice project; the owner does this in the console).
4. Deploy the staged functions there, set test-mode Stripe secrets, run the migration with `--project <practice> --bucket <practice bucket>`.
5. Point a copy of the app at it (change `projectId` and the config in a throwaway copy of `index.html`), and run through step 10 above.
6. Delete the practice project afterwards.

## What is deliberately not carried over

| Not carried | What people do |
|---|---|
| Push notification tokens | each person turns notifications on again in the new app |
| Google Calendar sign-in tokens (`googleAuthTokens`, keyed to a device) | each person signs in to Google again |
| `sentReminders` | nothing (the new reminder job starts fresh; it skips the band for an hour after the migration so old sets are not announced as new) |
| The stage plot **file** | it is copied as it is inside the settings entry (not moved to storage); a stage plot **link** works as before |

## Message to the band (edit the day and time)

> Heads up: on **<day>** at **<time>** the Gig Dashboard app is moving to a new version. For about 20 minutes the app won't open, so please
> don't add or change gigs for an hour around then. Afterwards: open the app (it'll update by itself), turn notifications on again, and sign in to
> Google Calendar again. Your gigs, charts, set lists, checklists and mileage all come across. Nothing to do before the day except open the app once
> so you're signed in. Anything looks off? Text me before you change anything.
