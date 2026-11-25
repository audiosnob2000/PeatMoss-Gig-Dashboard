> **Naming:** the product is called **Gig Dashboard**. It is a multi-band app; no single band's name belongs in anything
> customers see (app name, emails, Stripe product, notifications). Some technical names still carry the old project name
> (the Firebase project ID, the GitHub repo and address, the branch name); those are identifiers, not branding, and renaming
> them would break the live app, so leave them.

# Billing: decisions (not built yet)

Agreed in conversation. This is the design Stripe billing will be built to.

## What is sold
- **One subscription per person**, $6.99/month, plus a yearly option (about two months free, around $69/year).
- **One subscription covers every band that person is in.** Each band's other members pay for themselves, so a
  person starting many bands does not take revenue away: their bandmates are the new customers.
- A group plan (several people on one subscription) is deliberately postponed.

## Free trial rules
- **The band owner enters a card** when starting a band. The band gets **30 free days**, and the owner is charged
  automatically after that unless they cancel. This trial happens **once per person**: the first band an account
  starts gets it, later bands do not.
- **Bandmates join with no card.** They are covered for the band's first 30 days.
- **After the band's 30 days, everyone needs their own subscription.** Anyone joining after that must either
  subscribe straight away or start a **7-day trial with a card**. Stripe's card fingerprint is used so the same card
  cannot get a second trial. A brand-new email with no card gets only the subscribe screen.
- Trials are tied to the **card**, not the account or email, because a new email alone is trivial to make.

## When payment stops
- **Failed payment:** 7 days of grace while Stripe retries, then locked.
- **Cancelled:** access continues to the end of the period already paid for, then locked.
- **Locked means total lockout** (already built in the rules): no gigs, charts, sets or member list. They still see the
  band name and their own membership (to show the subscribe screen). Personal data (mileage, chart library) is theirs
  and is not affected.
- Everyone else in the band is unaffected by one person lapsing.

## How it works technically
- Stripe-hosted **Checkout** to pay and **Customer Portal** to manage or cancel. Card numbers never touch our servers.
- A **signature-verified webhook** is the only thing that writes subscription state; events are handled idempotently.
- A person's subscription status sets `covered` on their membership in **every** band they belong to, and on joining a
  band (`redeemInvite` already marks late joiners uncovered; it will check for an active subscription or trial).
- A **daily job** locks members when a band's 30 days end and they have no active subscription. Today nothing does
  this: a member with no flag counts as covered forever.
- A `complimentary` flag (set by the app's operator, not by users) for the owner's own founding band and any beta bands.

## Known and accepted
- **Shared logins** (one account used by a whole band) cannot be prevented cleanly. Revisit if it turns out to happen.
- Someone with a different card each time can still repeat trials. That takes effort for $6.99; accepted.

## Needed from the app's owner before building
- A **Stripe account** and its **test-mode keys** (never put in the chat; they go in as secrets).
- Whether the owner's own band should be complimentary.
- Decisions on sales tax, refunds and terms of service (Stripe Tax can handle tax collection).
- Check the local rules on charging automatically after a free trial (clear disclosure, easy cancellation, and a
  reminder before the first charge in some places). Stripe can send the reminder email.

## Build plan (for the session that has the Stripe test key)
Work on branch `claude/peatmoss-tenancy`, in `tenancy/`. Run `npm install` there first. Tests: `npm test` (emulator) and
`env -u https_proxy -u HTTPS_PROXY npm run e2e`. Do not deploy anything and do not merge to main.

1. **Check the key works and is test mode:** call the Stripe API for the account and confirm `livemode` is false. Never
   print the key. Stop if it is a live key.
2. **Create the product and prices in test mode** through the API: one product, a $6.99/month price and a yearly price
   (about $69). Keep the price ids in a small config file (not secret).
3. **Server functions** (in `tenancy/functions/`): start checkout, open the billing portal, and a signature-verified
   webhook that is the only writer of subscription state, idempotent per event. A person's status sets `covered` on their
   membership in every band; a `complimentary` flag keeps chosen bands free; a daily job locks members when a band's
   30 days end and they have no active subscription; trials are once per person and tied to the card fingerprint.
4. **App:** the subscribe screen (replacing the placeholder text on the "access paused" screen), a trial-ending banner,
   and a Manage billing button.
5. **Tests:** unit tests with a stand-in Stripe for the logic, plus real test-mode API calls for the request shapes. The
   webhook is tested with events signed locally with a test signing secret (no public URL is available in the sandbox).

What the owner must do later, in their own accounts: turn on the Customer Portal in Stripe (Settings › Billing ›
Customer portal), set the two Firebase secrets (secret key, webhook signing secret), and add the deployed webhook URL in
Stripe. The sandbox cannot do these, and the owner never pastes secrets into a chat.

---

## Status: built and tested in Stripe test mode (nothing deployed)

Built to the plan above. Choices made along the way:
- **Product and prices** (test mode) are in `functions/billing-config.json`: $6.99/month, $69/year. Re-create with
  `node scripts/setup-stripe.js` (safe to repeat; finds prices by lookup key, refuses a live key unless `--live`).
- **The owner's own founding band is complimentary**: `migrate.js` sets `billing.complimentary` by default (`--paid` opts out). For any other
  band: `node scripts/set-complimentary.js --project <id> [--live] <bandId> on|off`. Users cannot write this flag.
- **Sales tax is off** (`automaticTax: false` in `functions/index.js`); flip it once Stripe Tax is set up.
- **Trial rules as built:** the card trial is once per person. An owner still inside their band's 30 days gets a trial that
  ends exactly when the band's does (Stripe needs it at least 48h out, so never sooner); anyone else gets 7 days. A card
  already used for a trial on another subscription is refused: the new subscription is cancelled at once with no charge.
- **Free time belongs to a person's first band ever, and a card decides how much.** Starting that band shows a card
  step (`CardPromptScreen`): add a card for **30 free days counted from the band's start**, or tap **Not now** for **7
  free days with no card**. If the owner adds a card while the 7 days are still running, the band is raised to day 30
  from its start (so day 5 + card = 25 more days, never 30 more); after day 7 a card no longer brings it back. Only the
  band's current owner can raise it, and a refused repeat card never does. Bandmates never need a card while the band
  is in its free time. The mark is kept in `users/{uid}/private/bandTrial` (deleting a band does not reset it; the
  migration sets it for the founding band's owner). A later band they start has no free time: its owner is covered only by their
  own plan and, until they subscribe, cannot make invite codes. Handing ownership around changes nothing: the dates are
  fixed at creation. Someone with a different email and card can still start over; that is the accepted limit below.
- **Cancelling** keeps access to the end of the paid period (Stripe leaves the subscription active until then). A
  subscription cancelled immediately locks immediately. **Failed payment:** 7 days from the first failure, then locked.
- **Server pieces** (`functions/`): `coverage.js` (the one rule), `billing.js` (checkout, portal, webhook handler, daily
  job), wrappers in `index.js` (`startCheckout`, `openBillingPortal`, `stripeWebhook`, `enforceCoverage` at 03:30).
  State: `users/{uid}/billing/status` (readable by the person, written only by the webhook), plus server-only
  `users/{uid}/private/billing`, `stripeCustomers`, `stripeEvents`, `trialCards`.
- **App:** card step after starting a band, subscribe screen on the paused screen, a banner (trial ending, payment failing,
  cancellation pending, band free time ending, and a confirmation after paying), and Manage billing in Settings > Account.
- **Tests:** `npm test` (121, incl. `test/billing.test.js` with a stand-in Stripe and locally signed webhook checks),
  `npm run test:stripe` (real test-mode API: prices, Checkout, portal, a real trialing subscription and the same-card
  refusal; cleans up after itself), `npm run e2e` (39 in a browser).

### Other app items to come back to (not billing)
- [ ] **Perform mode (Fable's review, Change 2) is built** in the live app on branch `claude/perform-mode` (not merged until a pull request
      is opened and merged) and mirrored in this branch's new app. A song opened from a built set list now opens a full-screen
      viewer with the set position, Previous / Next (with the next song's key), swipe, the key / text size / scroll tools, and a tempo
      button that runs the metronome at the song's bpm; Exit returns to the set list. A song opened from the Charts list uses the
      same screen without Previous / Next. **Needs a real-phone check** (audio click, screen staying awake, swipe feel, notch
      spacing); only tested in an automated phone-sized browser. Not done: "attach a set to a gig so Gig Day opens straight into it"
      (also in the review's "Also worth adding"). Follow-up (branch `claude/chart-zoom`): pinch-to-zoom on picture charts (pan with one
      finger, double-tap to reset; not offered on a rotated picture) and a chart opened from the Charts list now swipes / Previous / Next
      through that list in the order shown (search filter included).
- [ ] **Look into Firestore cost and scale as more bands join.** The owner wants this investigated before many bands use the app.
      Known starting point from the review: the gig-reminder service reads EVERY gig (`collection('gigs').get()`) on each run, so
      reads grow with the total number of gigs across all bands; charts and files are also stored in the database rather than in
      file storage. To do: estimate reads/writes/storage per active band, find the heavy spots (reminder job, live listeners on
      whole collections, large chart/file documents), and decide fixes (query only upcoming gigs, move files to Cloud Storage, add a
      budget alert). The new multi-band app already scopes data per band; check it the same way. (The day-change check added in
      the small-fix release runs only on the phone and costs nothing.)
- [ ] **Small-fix release (live app branch `claude/calendar-sync-range`, also mirrored in this branch's new app):** calendar sync
      reaches through the end of next year; a cancelled gig is not "tonight's show" on Gig Day and an on-hold one shows with an
      "On hold" tag; Share schedule lists only upcoming gigs (on hold included, cancelled never; past unpaid gigs only on the calendar with the $ button on); the app notices when the date changes overnight; the
      mileage "season" totals count the current year only. Mileage rate: now by trip date from the `IRS_RATES` table at the top of
      index.html (72.5 cents Jan 1-Jun 30 2026, 76 cents from Jul 1 2026; branch `claude/mileage-rates` for the live app). **Add one line there
      whenever the IRS announces a new rate.** Buttons and switches now follow the color theme (live app branch `claude/theme-buttons`; the Band Stats chart colors, red Delete and the blue Map button are left alone).
- [ ] **Write an instructions / help page** (for the website and to link from the app) so people know how to do things: connect
      the Google Calendar, add a gig, make checklists, track mileage, invite bandmates, cancel. It should include "calendar
      events need a Location to sync as gigs". The owner said this is definitely needed at some point; not started.
- [ ] **Tell people the Google Calendar sync needs a Location.** (The one-line note is now on the Settings "Sync now" row in the
      live app, branch `claude/calendar-sync-range`, and in the new app. The instructions page above still needs it.) The sync only brings in calendar events that have a location
      filled in (it skips events with a blank location so personal notes like "Jim is off" don't become fake gigs). Gigs the app
      wrote itself are exempt. This is not written down anywhere a user would see it. Put it in the instructions: the website /
      help text and the Calendar settings screen in the app ("Events need a Location to sync as gigs"). A gig that is in range
      but missing is usually this.
- [ ] **The Gig Day checklist picker is also on its own branch for the LIVE app:** `claude/gigday-checklist-picker`, one
      commit on top of main (only `index.html` changes, no rules or server changes). It is NOT live until that branch is merged
      into main (a pull request is the easy way; merge it on a day without a gig, then close and reopen the app on the phone).
      The same feature is also in this branch's new multi-band app, so the cutover prep must reconcile the two.
- [ ] **Port "tonight's gig reads Unpaid" to the new multi-band app.** Done in the live app (branch
      `claude/gigday-checklist-picker`): on Gig Day, tonight's gig shows Unpaid with Mark paid (it is not on the unpaid list yet).
      The next day, or the next time the app is open, a gig still not marked paid is flagged unpaid, but only gigs from the first
      day of tracking onward (kept as `trackFrom`) and not cancelled or on-hold ones. "Paid" is remembered in `paidGigIds`; both
      are saved with the person's unpaid marks. The new app (this branch) still has the old behavior (Paid by default,
      "Mark unpaid"); the cutover prep must carry the change over so launch day does not undo it.
- [ ] **Port the grouped Settings to the new multi-band app.** Done in the live app (branch `claude/gigday-checklist-picker`):
      the 12 sections sit under The Band, Tools and You (grouped cards, value on the right), About by itself at the bottom;
      Notifications is now Reminders, Calendar is Calendar connection, Home is Home address. The new app's Settings has a
      different layout (it also has the Band panel with members and invites, and Recently deleted), so at the cutover regroup
      it the same way, with Members & invites under The Band. A "Tuner · soon" row was left out on purpose (no tuner exists).
- [x] *Done:* calendar sync now recognises private events from the title (private, corporate, party, birthday, anniversary,
      graduation, reunion, fundraiser, mitzvah, retirement; whole words, wedding still wins, unclear stays a bar gig). In both
      the live app (PR #192) and this branch's new app.
- [x] *Done:* the Shows tab footer counts only upcoming gigs ("2 upcoming gigs · 1 earlier"), and the Next up banner and the
      mileage log show dates as Fri, Nov 20 instead of 2026-11-20. In both the live app (PR #192) and this branch's new app.
- [x] *Done:* a checklist shows under the name it was given (no more "Gear's Checklist"; removing one asks "Remove Gear?"). In
      both the live app (PR #192) and this branch's new app.
- [ ] **A startup bug already in the live app (found while testing the picker):** a checklist tick made within about a second
      of opening the app can be lost. The app briefly sets itself up twice after a page load, and a tick that lands before it
      is ready to save is never written, so it is undone. Not caused by the picker (an unmodified copy of main does the same,
      2 times in 3 in the test). A simple guard did not fix it; the real fix is in how the app starts up and saves. Decide
      whether it is worth fixing, and check whether the new multi-band app behaves the same way.

- [ ] **Gig Day: the two buttons next to each other now do the same thing.** "Navigate" was changed to ask "Track miles for
      this trip?" first (like the calendar), so the "Track miles" button beside it is a duplicate (it already opened that
      question, and Skip went to the maps chooser). Decide: (1) remove "Track miles", or (2) make it start tracking only,
      with no maps (for someone already driving or not needing directions). Recommended: option 2.
- [x] **The flaky browser test** ("restoring a show while signed in to Google ...") failed in a few runs. The test checked
      for the Google call and the database writes the instant the row left the screen, before they had happened. It now waits
      for them. Fixed; look again only if it fails again.
- [x] *Done from the review's "small leftovers":* Settings > Default view now reads Calendar, Shows, Charts/Sets and Checklists
      (live app: branch `claude/gigday-checklist-picker`, awaiting merge; new app: this branch).
- [ ] **The Gig Dashboard Review's "Fix now" list** (11 items: calendar sync dates, reminders for calendar gigs, cancelled
      gigs, mileage rate, large PDFs and more) has not been worked on in this session. Check what is still open.

### Built since: Gig Day checklist picker
The Gig Day "What to bring" card has **Choose lists ›**. Until a person chooses, it shows all their lists (as before). The
choice is remembered for every gig (kept in the same saved checklist document, so it is per band and syncs to their other
devices) and can be changed any time; **Show all lists** goes back. With one list chosen, its heading goes away. Not built, on
purpose: a different choice per gig, and tagging a list with a gig type so it appears by itself (see the mock-up page).
One bug found while testing and fixed: the app could take its own earlier save as news and put an old choice back over a
quick change, so the saved choice is now only read from a snapshot that is not the app's own pending save.

### Launch checklist (owner, in order; tick them off here)
- [ ] 1. **Stripe reminder emails and the live portal.** In the Stripe Dashboard turn on the trial-ending reminder and the
      upcoming-renewal reminder for yearly plans (about 30 days before). Check the LIVE Customer Portal the same way the
      test one is set: cancelling allowed (at period end), card updates and invoices on.
- [ ] 2. **The three secrets, deploy, and the webhook.** Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
      `RESEND_API_KEY` with `firebase functions:secrets:set` (use the Firebase account that owns the project), deploy,
      then add the deployed `stripeWebhook` URL in Stripe with the events listed below and copy its signing secret into
      `STRIPE_WEBHOOK_SECRET`.
- [ ] 3. **Book the accountant (or lawyer) session.** Sales tax, New York's automatic-renewal rules and the other places
      you will sell. Details in the numbered list below.
- [ ] 4. **Test-mode signup and the email.** Do a signup with Stripe's test card `4242 4242 4242 4242` and confirm the
      confirmation email arrives with the price, first-charge date and cancel steps.
- [ ] 3b. **Terms and Privacy pages: fill in the blanks and get them reviewed.** The pages are built (`terms.html` and
      `privacy.html` in the app's root, linked from sign-up, the plan screens and Settings) but they are DRAFTS.
      Highlighted yellow on the pages, you need to fill in: your **business name and address** (both pages), a
      **support email** that you actually read (both pages; customers use it for questions, and if they cannot use the delete button), and confirm the
      **refund wording** and **governing law (New York)**. Take both pages to the accountant or lawyer in item 3 for a
      review, then delete the yellow "Draft" box from each page. A test (`test/legal.test.js`) keeps the pages' numbers in
      step with the code and fails if a stray blank is left unmarked.
- [ ] 3a. **(Ask Claude later) Make the one-page brief to bring to the accountant or lawyer.** Not made yet, on purpose. It
      would hold the two pages (Terms and Privacy) as files and the questions to ask: sales tax, New York's automatic-renewal
      rules, whether a P.O. box is acceptable as the address, the refund and governing-law wording, and whether the pages are
      enough for your situation. You hand them the pages and ask them to say what to change.
- [ ] 3d. **Decide how to run the business (look at these later; bring them to the accountant session).** The answer fills in the
      "operator name and address" blank on the Terms and Privacy pages, and decides what the app brand is registered as. Three
      options, from the owner's notes:
      1. **Launch as a sole proprietor.** Costs nothing, and an assumed name (a DBA, "doing business as Gig Dashboard") can be
         added for the app brand. The downside: **no liability shield**, so personal assets are exposed if something goes wrong.
      2. **Sole proprietor plus insurance.** Small business or cyber liability insurance can cost less than the LLC process and
         covers some of the same risks. Worth getting a quote.
      3. **Form an LLC.** The safest of the three, but it comes with the **publication cost**. (New York LLCs have to publish a
         notice in newspapers, and the cost varies a lot by county. Ask the accountant for the real number for your county.)
      Questions to ask: what the assumed-name filing involves and costs in your county, a real quote for the LLC publication,
      what an insurance policy would cover and cost, and whether launching under option 1 or 2 first and forming the LLC later
      is sensible.
- [ ] 3c. **Give Stripe the page addresses** (Dashboard > Settings > Public details, or the terms and privacy fields):
      the pages live next to the app, at `<where the app is hosted>/terms.html` and `/privacy.html`.
- [ ] After about a month live: the trial and repeat-card review (see "To check after the first month live").

The detail behind each item is in the list below.

### Still to do by the owner, in their own accounts
1. Stripe Dashboard (test, then live): turn on the **Customer Portal** (Settings > Billing > Customer portal), allow
   cancelling (the TEST-mode portal is already set to cancel at period end, with card updates and invoices on; check the
   live one the same way), and in Settings > Billing > Subscriptions and emails turn on the **trial-ending reminder** and the
   **upcoming-renewal reminder for yearly plans** (set to about 30 days before, which falls inside the 15 to 45 day
   window on the checklist). Re-read the checklist's reminder windows with the accountant or lawyer.
2. `firebase functions:secrets:set STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
   Also set `RESEND_API_KEY` for the confirmation email (steps above). Then check one real signup in test
   mode: you should get the confirmation with the price, the first-charge date and the cancel steps.
3. After deploying, add the `stripeWebhook` URL in Stripe (Developers > Webhooks) for: `checkout.session.completed`,
   `customer.subscription.created|updated|deleted`, `invoice.payment_failed`. Copy that endpoint's signing secret into step 2.
4. Before going live, re-run `node scripts/setup-stripe.js --live` with the live key to create the live prices, and
   decide sales tax, refunds, terms, and the local rules on auto-charging after a free trial (see above).
5. **Before going live with real customers, talk to an accountant or bookkeeper** (a short session is enough). Ask: "I'm
   selling a $6.99/month app subscription to US customers. Do I need to collect sales tax anywhere?" Sales tax stays
   **off** until then. If the answer is yes, turn on Stripe Tax in the Dashboard (business address, default product tax
   category) and ask for the small code change: set `automaticTax: true` in `functions/index.js` and add
   `customer_update: { address: 'auto' }` to the Checkout request in `billing.js`, since checkout reuses an existing
   Stripe customer. Stripe Tax only calculates tax; registering with states and remitting it is still on you.
6. Add your real site address to `allowedOrigins` in `functions/index.js` if it is not the Firebase one.

### To check after the first month live
- In Stripe, look at how many trials turned into paying customers (Billing > Subscriptions, filter by trial).
- Count how many were refused by the repeat-card check: those are subscriptions cancelled during their trial with no
  charge. In Firestore they are the `users/{uid}/billing/status` documents with `trialRefused: true`.
- Near zero refusals means the check is harmless and needs nothing. Many refusals means people are repeating trials, so
  consider tightening (or dropping the 7-day trial for late joiners). Many trials that never convert is a separate
  question about the trial length and the subscribe screen.

### Setting up the confirmation email with Resend (owner steps)
The server sends each confirmation straight through Resend's API (`functions/mailer.js`). It does NOT use Firebase's
"Trigger Email from Firestore" extension, because Firebase Extensions shuts down on 31 March 2027 (no installs or edits
after that), and there is no replacement for that extension.
(SendGrid was tried first, but it is only a ~2 month trial. Resend's free plan, as shown on its pricing page, is $0 for
3,000 emails a month with a 100 a day cap. Any service with an HTTP API would do; only `mailer.js` would change.)
1. **Resend account and domain:** done. `gigdashboard.com` is added and **verified** (DKIM, SPF and DMARC records are in
   Spaceship's Advanced DNS). Leave "Enable receiving" off.
2. **API key:** in Resend, API keys > Create API Key, named `Gig Dashboard confirmations`, **Sending access**, domain
   `gigdashboard.com`. Copy it once. **Never paste it into a chat or the repo.**
3. **Give it to the functions as a secret** (from the folder that has the Firebase project, using the Firebase account that
   owns the project; it prompts you to paste the value):
   `firebase functions:secrets:set RESEND_API_KEY`
4. **Optional reply-to address:** deploy asks for `REPLY_TO_EMAIL`. Enter an inbox you read (customers' replies go
   there, since our domain does not receive mail) or leave it blank.
5. **Test it** after deploying: complete a trial signup in Stripe test mode with the test card `4242 4242 4242 4242`
   and confirm the email arrives with the price, the first-charge date and the cancel steps. If it does not, check
   Resend's Logs page and the function logs (`stripeWebhook`). A missing key or a failed send never blocks billing: it is
   logged and the next subscription event tries again.
The From address is `Gig Dashboard <billing@gigdashboard.com>` (set in `functions/index.js`).

### Automatic-renewal rules (New York General Business Law 527-a, and similar laws elsewhere)
Built to the owner's checklist of the rules. This is not legal advice; the accountant/lawyer session below should confirm it.
| Rule | How it is met |
|---|---|
| Clear disclosure of price, billing frequency, renewal and cancellation **before** consent or payment | Plain-words terms are on the plan screen above the buttons (`PlanPicker`) and repeated on Stripe's checkout page above the pay button (`disclosure()` in `billing.js`). |
| Affirmative opt-in consent | An unticked "I agree..." box must be ticked; the buttons stay disabled until it is. The server **refuses** checkout unless `consent: true` is sent. |
| Retainable confirmation with key terms and how to cancel | The app shows "You're all set" with the terms and a **Save a copy** button. An email with the same content is sent by the server through Resend once the `RESEND_API_KEY` secret is set (see below). |
| Cancel the same way you signed up, no obstacles | Signed up online, cancel online: Settings > Account > Manage billing > Cancel subscription (Stripe Customer Portal). The steps are shown on the plan screen, the Stripe page, the confirmation and in Settings. |
| Renewal and trial-ending reminders | Stripe sends these; set them in the Dashboard (see to-do 3). The in-app banner also warns in the last 7 days of a trial. |
| No price rises without consent | The code never changes an existing customer's price. Any future rise needs their opt-in (or the 14-day cancel-with-pro-rata-refund option). Do not edit a live Price; create a new one and ask first. |

### Open decisions and gaps
- **Confirmation email is built and tested but not live** until the `RESEND_API_KEY` secret is set and the functions are
  deployed (steps above). Until then the in-app confirmation is the retainable copy. Needed before real customers sign up.
- **The 7-day card trial for people joining after day 30 is still in.** Discussed dropping it (late joiners would just
  see Subscribe); not decided.
- If the owner cancels a card trial during the trial, the band keeps the 30 days the card unlocked (they were never
  charged). Accepted; revisit if abused.

### Leaving and deleting (built)
- **Cancel subscription** (`cancelSubscription` in `functions/account.js`): stops renewal at the end of the paid period; access
  continues until then. The "no bands" notice on the join/start screen offers it in one tap to anyone who is in no bands but
  still has a live subscription, with a **Keep it** option for people about to join another band. Leaving a band never
  touches a subscription (it belongs to the person, not to a band).
- **Delete my account** (`deleteAccount`, Settings > Account): the person types DELETE. The server (1) refuses if they own a
  band that still has other members (they hand it over first; nothing is changed), (2) cancels the Stripe subscription
  immediately (no refund for the rest of the period, per the Terms; if Stripe fails, nothing is deleted and it is safe to
  retry), (3) removes them from every band, clearing their checklist, unpaid marks, availability and phone tokens there,
  (4) deletes any band where they were the only member, with its join codes, (5) erases their user data (mileage, private
  charts, billing records) and (6) deletes their sign-in account. Shows, sets and charts they added to a band stay with the
  band. Kept on purpose: Stripe's own customer and payment records, and the anonymous card fingerprint in `trialCards` so a
  card still gets one trial. Google Calendar tokens are keyed by device, not person, so they are not removed; the Privacy page
  tells people to revoke access in their Google account.
- Someone who deletes and signs up again with the same email can get a new first-band free period (the card fingerprint still
  blocks a second card trial). This is part of the accepted limit on repeated free time.
- Still not built: a delete-band function for owners who want to remove a band that has other members.

### Known limits
- Webhook de-duplication is check-then-write: two simultaneous deliveries of one event could both run. Every handler is
  safe to repeat, and the card claim is transactional, so the effect is the same.
- The daily job reads every member document; fine at this size, revisit at thousands of bands.
