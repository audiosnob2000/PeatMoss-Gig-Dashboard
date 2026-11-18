'use strict';
// Sends one email through Resend's HTTP API. A plain function with an injectable fetch, so the request
// shape is tested without the network. (Firebase's "Trigger Email" extension is being shut down on
// 31 March 2027, so the server sends directly instead.)

function makeResendMailer({ apiKey, from, replyTo, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('No Resend API key.');
  if (!from) throw new Error('No From address.');
  return async function sendEmail({ to, subject, text }) {
    const body = { from, to: [to], subject, text };
    if (replyTo) body.reply_to = replyTo;
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`Resend ${res.status} ${detail}`);       // never includes the key
    }
    return true;
  };
}

module.exports = { makeResendMailer };
