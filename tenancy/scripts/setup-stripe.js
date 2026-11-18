'use strict';
// Creates (or finds) the PeatMoss product and its two prices in whichever Stripe account the
// key belongs to, and writes the ids to functions/billing-config.json. Safe to run twice:
// prices are found by lookup_key. Refuses to run against a live key unless --live is passed.
// In the sandbox the key is injected by the network proxy; elsewhere set STRIPE_SECRET_KEY.
const fs = require('fs');
const path = require('path');
const Stripe = require('../functions/node_modules/stripe');

const key = process.env.STRIPE_SECRET_KEY || 'proxy-injected';
const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
const CONFIG = path.join(__dirname, '..', 'functions', 'billing-config.json');
const PRICES = [
  { lookup_key: 'peatmoss_monthly', unit_amount: 699, interval: 'month', nickname: 'Monthly' },
  { lookup_key: 'peatmoss_yearly', unit_amount: 6900, interval: 'year', nickname: 'Yearly' },
];

(async () => {
  const bal = await stripe.balance.retrieve();      // balance carries livemode; the account object does not
  if (bal.livemode && !process.argv.includes('--live')) throw new Error('Live key: refusing. Pass --live to really do this.');
  console.log('mode:', bal.livemode ? 'LIVE' : 'test');

  // Search is eventually consistent, so never use it to decide whether to create. Prices are
  // found by lookup_key (strongly consistent) and carry their product; only create a product
  // when no price exists yet.
  const existing = (await stripe.prices.list({ lookup_keys: PRICES.map(p => p.lookup_key), active: true })).data;
  let productId = existing[0] && existing[0].product;
  if (!productId) {
    productId = (await stripe.products.create({ name: 'PeatMoss subscription', description: 'One subscription covers every band you play in.', metadata: { app: 'peatmoss' } })).id;
  }

  const out = { productId, prices: {} };
  for (const p of PRICES) {
    let price = existing.find(x => x.lookup_key === p.lookup_key);
    if (!price) price = await stripe.prices.create({ product: productId, currency: 'usd', unit_amount: p.unit_amount, recurring: { interval: p.interval }, lookup_key: p.lookup_key, nickname: p.nickname });
    out.prices[p.interval === 'month' ? 'monthly' : 'yearly'] = price.id;
  }
  fs.writeFileSync(CONFIG, JSON.stringify(out, null, 2) + '\n');
  console.log(out);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
