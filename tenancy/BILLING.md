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
- A `complimentary` flag (set by the app's operator, not by users) for Peat Moss and any beta bands.

## Known and accepted
- **Shared logins** (one account used by a whole band) cannot be prevented cleanly. Revisit if it turns out to happen.
- Someone with a different card each time can still repeat trials. That takes effort for $6.99; accepted.

## Needed from the app's owner before building
- A **Stripe account** and its **test-mode keys** (never put in the chat; they go in as secrets).
- Whether Peat Moss should be complimentary.
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
- **Peat Moss is complimentary**: `migrate.js` sets `billing.complimentary` by default (`--paid` opts out). For any other
  band: `node scripts/set-complimentary.js --project <id> [--live] <bandId> on|off`. Users cannot write this flag.
- **Sales tax is off** (`automaticTax: false` in `functions/index.js`); flip it once Stripe Tax is set up.
- **Trial rules as built:** the card trial is once per person. An owner still inside their band's 30 days gets a trial that
  ends exactly when the band's does (Stripe needs it at least 48h out, so never sooner); anyone else gets 7 days. A card
  already used for a trial on another subscription is refused: the new subscription is cancelled at once with no charge.
- **The shared free 30 days belong to a person's first band ever** (`createBand`, mark kept in
  `users/{uid}/private/bandTrial`, so deleting a band does not reset it; the migration sets it for Peat Moss's owner).
  A later band they start has no free time: its owner is covered only by their own plan and, until they subscribe, cannot
  make invite codes. Handing ownership around changes nothing: the band's free period is fixed at creation, and a new
  owner's card trial ends with the band's, never 30 fresh days. Someone with a different email and card can still start
  over; that is the accepted limit below.
- **Cancelling** keeps access to the end of the paid period (Stripe leaves the subscription active until then). A
  subscription cancelled immediately locks immediately. **Failed payment:** 7 days from the first failure, then locked.
- **Server pieces** (`functions/`): `coverage.js` (the one rule), `billing.js` (checkout, portal, webhook handler, daily
  job), wrappers in `index.js` (`startCheckout`, `openBillingPortal`, `stripeWebhook`, `enforceCoverage` at 03:30).
  State: `users/{uid}/billing/status` (readable by the person, written only by the webhook), plus server-only
  `users/{uid}/private/billing`, `stripeCustomers`, `stripeEvents`, `trialCards`.
- **App:** subscribe screen on the paused screen, a banner (trial ending, payment failing, cancellation pending, band trial
  ending), and Manage billing in Settings > Account.
- **Tests:** `npm test` (101, incl. `test/billing.test.js` with a stand-in Stripe and locally signed webhook checks),
  `npm run test:stripe` (real test-mode API: prices, Checkout, portal, a real trialing subscription and the same-card
  refusal; cleans up after itself), `npm run e2e` (30 in a browser).

### Still to do by the owner, in their own accounts
1. Stripe Dashboard (test, then live): turn on the **Customer Portal** (Settings > Billing > Customer portal), allow
   cancelling, and enable Stripe's **trial-ending reminder emails** (Settings > Billing > Subscriptions and emails).
2. `firebase functions:secrets:set STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
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

### Open decisions and gaps (as of the first-band-only change)
- **No card prompt when a band is started yet.** The plan says the owner enters a card at band start; the app does not
  ask. The card trial is only offered in the banner during the band's last 7 days and on the locked screen.
- **The 7-day card trial for people joining after day 30 is still in.** Discussed dropping it (late joiners would just
  see Subscribe); not decided.

### Known limits
- Webhook de-duplication is check-then-write: two simultaneous deliveries of one event could both run. Every handler is
  safe to repeat, and the card claim is transactional, so the effect is the same.
- The daily job reads every member document; fine at this size, revisit at thousands of bands.
