'use strict';
// Builds a realistic copy of TODAY'S LIVE DATA in the Firestore emulator, so the cutover can be rehearsed on something that looks like
// the real thing: the flat collections, `deviceId` as the owner, charts with their photo / PDF / HTML inside the entry, unpaid marks,
// push tokens, a stage plot file, and leftovers from before people signed in (device ids that no account owns).
// Nothing here talks to a real project: it needs FIRESTORE_EMULATOR_HOST (and the Auth emulator for the people).

const zlib = require('zlib');

// A real PNG of noise (it does not compress, so the size is what a real photo chart's would be).
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, seed) {
  let x = seed * 2654435761 >>> 0; const rnd = () => (x = (x * 1664525 + 1013904223) >>> 0) >>> 24;
  const raw = Buffer.alloc((w + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let i = 0; i < w; i++) raw[y * (w + 1) + 1 + i] = rnd(); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

const dayStr = n => { const d = new Date(Date.now() + n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

const PEOPLE = [
  { key: 'olive', email: 'olive@example.com', role: 'owner' },
  { key: 'adam', email: 'adam@example.com', role: 'admin' },
  { key: 'mia', email: 'mia@example.com', role: 'member' },
  { key: 'max', email: 'max@example.com', role: 'member' },
];

// Creates the people in the Auth emulator (with a known password) and returns { key -> uid }.
async function makePeople(auth) {
  const uids = {};
  for (const p of PEOPLE) { const u = await auth.createUser({ email: p.email, password: 'secret123', displayName: p.key[0].toUpperCase() + p.key.slice(1) }); uids[p.key] = u.uid; }
  return uids;
}

// Writes the old, flat data. Returns a description of what was written (counts and the ids the checks need).
async function seedLive(db, uids) {
  const put = (p, d) => db.doc(p).set(d);
  const owner = uids.olive, info = { counts: {}, inline: { image: 0, file: 0, html: 0 }, ids: {} };
  const venues = ['Rusty Anchor', 'Amsterdam', 'Black Pearl', 'West Sayville Fire Dept', 'Empire City', 'Lakeside Concert Series', 'Baiting Hollow Farm', 'The Mansion'];

  // 120 gigs from last year to next year, some today and tomorrow, a few cancelled / on hold
  const gigs = [];
  for (let i = 0; i < 120; i++) {
    const n = -200 + i * 4;
    const status = i % 17 === 0 ? 'cancelled' : i % 11 === 0 ? 'hold' : 'confirmed';
    gigs.push([`g${i}`, { venue: venues[i % venues.length], date: dayStr(n), time: '8:00-11:00 PM', type: i % 9 === 0 ? 'wedding' : 'bar', status, location: 'Long Island, NY', notes: i % 5 === 0 ? 'Load in through the back' : '' }]);
  }
  gigs.push(['tonight', { venue: 'Tonight Tavern', date: dayStr(0), time: '9 PM', type: 'bar', status: 'confirmed', location: 'Port Jefferson, NY' }]);
  for (const [id, d] of gigs) await put(`gigs/${id}`, d);
  info.counts.gigs = gigs.length;

  // 60 charts: photos, PDFs, HTML, typed and linked; owners are real accounts; some private; some with no `shared` flag
  let songs = 0;
  const addSong = async (id, d) => { await put(`songs/${id}`, d); songs++; };
  const people = Object.values(uids);
  for (let i = 0; i < 30; i++) {
    const w = 300, h = 400;
    await addSong(`photo${i}`, { name: `Photo Chart ${String(i).padStart(2, '0')}`, type: 'image', content: dataUrl('image/png', png(w, h, i + 1)), fileName: `chart${i}.jpg`, key: 'G', tempo: String(90 + i), tag: 'rock', rotated: i % 7 === 0, deviceId: people[i % 4], ...(i % 6 === 0 ? { shared: false } : i % 2 ? { shared: true } : {}) });
    info.inline.image++;
  }
  for (let i = 0; i < 5; i++) { await addSong(`pdf${i}`, { name: `PDF Chart ${i}`, type: 'file', content: dataUrl('application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200000, i + 65)])), fileName: `c${i}.pdf`, deviceId: owner, shared: true }); info.inline.file++; }
  for (let i = 0; i < 3; i++) { await addSong(`html${i}`, { name: `HTML Chart ${i}`, type: 'html', content: `<html><body><h1>Chart ${i}</h1><pre>G  C  D\nLyric line</pre></body></html>`, fileName: `c${i}.html`, deviceId: owner }); info.inline.html++; }
  for (let i = 0; i < 15; i++) await addSong(`text${i}`, { name: `Typed Chart ${i}`, type: 'text', content: 'G   C   D\nA lyric line\n', key: 'D', tempo: '120', deviceId: people[i % 4], ...(i % 5 === 0 ? { shared: false } : {}) });
  for (let i = 0; i < 7; i++) await addSong(`link${i}`, { name: `Linked Chart ${i}`, type: 'link', content: `https://drive.google.com/file/d/example${i}`, deviceId: owner });
  info.counts.songs = songs;

  // set lists: a typed one, a photo sheet, a PDF, and two built from charts
  await put('setlists/s-text', { name: 'Saturday (typed)', type: 'text', content: '1. Opener\n2. Closer', updatedAt: dayStr(-9) });
  await put('setlists/s-photo', { name: 'Wedding sheet (photo)', type: 'image', content: dataUrl('image/png', png(300, 400, 99)), fileName: 'sheet.jpg', updatedAt: dayStr(-8) }); info.inline.image++;
  await put('setlists/s-pdf', { name: 'Summer plan (PDF)', type: 'file', content: dataUrl('application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100000, 90)])), fileName: 'plan.pdf', updatedAt: dayStr(-7) }); info.inline.file++;
  await put('setlists/s-built1', { name: 'Friday night', type: 'charts', structure: 'sets', sets: [{ songs: ['photo1', 'photo3', 'text1'] }, { songs: ['photo5', 'pdf0'] }], updatedAt: dayStr(-3) });
  await put('setlists/s-built2', { name: 'Brunch', type: 'charts', structure: 'flat', sets: [{ songs: ['photo7', 'text2', 'link1'] }], updatedAt: dayStr(-2) });
  info.counts.setlists = 5;

  // availability: some of everyone
  let ua = 0; for (const [k, uid] of Object.entries(uids)) for (let i = 0; i < 3; i++) { await put(`unavailableDates/${dayStr(10 + i * 7)}__${uid}`, { date: dayStr(10 + i * 7), name: k, uid }); ua++; }
  info.counts.unavailableDates = ua;

  // mileage: 20 trips each, plus two from a phone that was never signed in (a device id no account owns)
  let mt = 0; for (const uid of people) for (let i = 0; i < 20; i++) { await put(`mileageTrips/t-${uid.slice(0, 4)}-${i}`, { miles: 10 + i, date: dayStr(-i * 6), label: venues[i % venues.length], deviceId: uid }); mt++; }
  await put('mileageTrips/t-oldphone-1', { miles: 33, date: dayStr(-120), label: 'Old phone trip', deviceId: 'dev-1a2b3c4d5e' });
  await put('mileageTrips/t-oldphone-2', { miles: 21, date: dayStr(-100), label: 'Old phone trip 2', deviceId: 'dev-1a2b3c4d5e' }); mt += 2;
  info.counts.mileageTrips = mt;

  // each person's checklist and unpaid marks (the new shape: gigIds, paidGigIds, trackFrom)
  for (const [k, uid] of Object.entries(uids)) {
    await put(`checklists/${uid}`, { members: [{ id: 'm1', name: 'Gear', items: [{ id: 'i1', text: 'Guitar', checked: false }, { id: 'i2', text: 'Cables', checked: true }] }], gigDayLists: null });
    await put(`unpaidGigs/${uid}`, k === 'olive' ? { gigIds: ['g20', 'g21'], paidGigIds: ['g19'], trackFrom: dayStr(-60) } : { gigIds: ['g22'] });
  }
  info.counts.checklists = 4; info.counts.unpaidGigs = 4;

  // settings: the Google calendar and a stage plot file inside the entry
  await put('bandSettings/global', { calendarId: 'peatmoss@group.calendar.google.com' });
  await put('bandSettings/stagePlot', { stagePlotUrl: '', stagePlotFile: { type: 'image', content: dataUrl('image/png', png(200, 150, 7)), fileName: 'plot.jpg' } });

  // things that are NOT carried over
  for (let i = 0; i < 6; i++) await put(`fcmTokens/tok${i}`, { token: 'tok' + i });
  for (let i = 0; i < 2; i++) await put(`googleAuthTokens/dev${i}`, { refreshToken: 'secret' + i });
  for (let i = 0; i < 20; i++) await put(`sentReminders/r${i}`, { sentAt: Date.now() - i * 1000 });
  return info;
}

const OLD_COLLECTIONS = ['gigs', 'setlists', 'songs', 'unavailableDates', 'mileageTrips', 'checklists', 'unpaidGigs', 'bandSettings', 'fcmTokens', 'googleAuthTokens', 'sentReminders'];
module.exports = { PEOPLE, makePeople, seedLive, dayStr, OLD_COLLECTIONS, png, dataUrl };
