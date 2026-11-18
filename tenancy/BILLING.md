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
