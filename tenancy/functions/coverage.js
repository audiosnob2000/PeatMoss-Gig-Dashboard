'use strict';
// Who is covered, as pure functions. No database, no Stripe: band.js (on joining), billing.js
// (on every subscription change) and the daily job all ask the same question here, so the
// answer cannot drift between them.

const DAY = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 7;          // a failed payment keeps access this long while Stripe retries

// `sub` is the small summary the webhook keeps in users/{uid}/billing/status, or null.
//   active / trialing  -> covered. (A subscription cancelled "at period end" stays active until
//                         the period ends, so "access to the end of what was paid" falls out.)
//   past_due           -> covered for GRACE_DAYS after the first failure, then locked.
//   anything else      -> not covered (cancelled now, unpaid, never finished checkout...).
function subscriptionCovers(sub, now) {
  if (!sub) return false;
  if (sub.status === 'active' || sub.status === 'trialing') return true;
  if (sub.status === 'past_due') return typeof sub.pastDueSince === 'number' && now < sub.pastDueSince + GRACE_DAYS * DAY;
  return false;
}

// A person's coverage in one band. `band` is the band document's data.
//   complimentary band -> always. The band's first 30 days -> everyone. After that -> own plan.
function memberCovered(band, sub, now) {
  const billing = (band && band.billing) || {};
  if (billing.complimentary === true) return true;
  if (now <= (billing.trialEndsAt || 0)) return true;
  return subscriptionCovers(sub, now);
}

module.exports = { DAY, GRACE_DAYS, subscriptionCovers, memberCovered };
