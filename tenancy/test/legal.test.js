// The Terms and Privacy pages state numbers that the code enforces (prices, free days, grace days, how long
// deleted items wait). This test reads those numbers from the real code and checks the pages say the same, so a
// future change to billing cannot quietly leave the pages wrong. It also lists the blanks the owner must fill in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const band = require('../functions/band');
const coverage = require('../functions/coverage');
const trash = require('../functions/trash');
const billing = require('../functions/billing');

const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const terms = read('terms.html');
const privacy = read('privacy.html');
const text = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// The only blanks allowed to remain, each one highlighted on the page. Fill these in, then delete the DRAFT notice.
const KNOWN_BLANKS = new Set([
  '[OPERATOR NAME AND ADDRESS]', '[SUPPORT EMAIL]', '[Owner to confirm this refund wording.]', '[Owner and lawyer to confirm.]',
]);

test('both pages are well-formed, link to each other and back to the app, and are named Gig Dashboard', () => {
  for (const [name, html] of [['terms.html', terms], ['privacy.html', privacy]]) {
    assert.match(html, /^<!doctype html>/i, name);
    assert.match(html, /<html lang="en">/, name);
    assert.match(html, /<meta name="viewport"/, name);
    assert.match(html, /<title>[^<]*Gig Dashboard<\/title>/, name);
    assert.match(html, /<a href="\.\/">/, name + ' links back to the app');
    assert.doesNotMatch(html, /peat\s?moss|peatmoss/i, name + ' must not carry the old name');
  }
  assert.match(terms, /href="privacy\.html"/);
  assert.match(privacy, /href="terms\.html"/);
});

test('the Terms state the same prices, free days, grace period and trash period the code uses', () => {
  const t = text(terms);
  assert.match(t, /\$6\.99 per month/);
  assert.match(t, /\$69 per year/);
  assert.match(t, new RegExp(`${band.NO_CARD_TRIAL_DAYS} free days`), 'no-card free days');
  assert.match(t, new RegExp(`${band.TRIAL_DAYS} free days counted from the day the band was started`), 'full free days with a card');
  assert.match(t, new RegExp(`${billing.CARD_TRIAL_DAYS}-day free trial with a card`), 'late joiner card trial');
  assert.match(t, new RegExp(`for\\s+${coverage.GRACE_DAYS} days`), 'payment grace days');
  assert.match(privacy + terms, new RegExp(`${trash.TRASH_DAYS} days`), 'recently-deleted days');
  assert.match(t, /Settings → Account → Manage billing → Cancel subscription/, 'the same cancel path the app shows');
  assert.match(t, /renews automatically/i);
  assert.match(t, /Settings → Account → Delete my account/, 'the delete button the app shows');
  assert.match(t, /without telling you in advance and getting your agreement/i, 'price rises need consent');
});

test('the Privacy page covers what the app actually collects and uses', () => {
  const p = text(privacy);
  for (const phrase of ['email address', 'mileage log', 'private chart library', 'card fingerprint', 'Google Calendar', 'Stripe',
    'Resend', 'OpenStreetMap', 'Open-Meteo', 'notifications', 'location', 'local storage', 'We do not sell your information',
    'no advertising and no analytics', 'Delete my account', 'What stays', 'anonymous card fingerprint']) {
    assert.ok(p.includes(phrase), `missing: ${phrase}`);
  }
  assert.match(p, /never see or store your card number/);
});

test('every blank still in the pages is a known, highlighted one (and the draft notice is there until they are filled)', () => {
  for (const [name, html] of [['terms.html', terms], ['privacy.html', privacy]]) {
    const marks = [...html.matchAll(/<mark class="todo">([^<]+)<\/mark>/g)].map(m => m[1]);
    for (const m of marks) assert.ok(KNOWN_BLANKS.has(m), `${name}: unexpected highlighted blank ${m}`);
    const plain = text(html.replace(/<mark class="todo">[^<]+<\/mark>/g, ''));
    assert.doesNotMatch(plain, /\[[A-Z][A-Za-z ]+\]/, `${name}: an unmarked placeholder is left in the text`);
    if (marks.length) assert.match(html, /class="draft"/, `${name}: blanks remain, so the draft notice must too`);
  }
});
