const { test, before, after, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, deleteField } = require('firebase/firestore');

const A = 'bandA', B = 'bandB';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-peatmoss',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(async () => { await env.cleanup(); });

// Fresh, identical data before every test.
//   olive owner, adam admin, mia and max members, all covered (paid up or in trial).
//   ursula (member) and carl (admin) have a lapsed personal subscription: covered:false.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const put = (p, d) => setDoc(doc(db, p), d);
    for (const [id, name] of [[A, 'Band A'], [B, 'Band B']]) {
      await put(`bands/${id}`, { name, ownerUid: 'olive', timeZone: 'America/New_York', billing: { trialEndsAt: 1 } });
    }
    const roles = { olive: 'owner', adam: 'admin', mia: 'member', max: 'member' };
    for (const [uid, role] of Object.entries(roles)) await put(`bands/${A}/members/${uid}`, { role });
    await put(`bands/${A}/members/ursula`, { role: 'member', covered: false });
    await put(`bands/${A}/members/carl`, { role: 'admin', covered: false });
    await put(`bands/${B}/members/bob`, { role: 'owner' });
    for (const b of [A, B]) {
      await put(`bands/${b}/gigs/g1`, { venue: 'Rusty Anchor', date: '2027-01-01' });
      await put(`bands/${b}/setlists/s1`, { name: 'Saturday' });
      await put(`bands/${b}/songs/shared1`, { name: 'Brown Eyed Girl', shared: true, uid: 'mia' });
    }
    await put(`users/mia/charts/lib1`, { name: 'My practice chart', type: 'text', content: 'x' });
    await put(`bands/${A}/gigs/trashed1`, { venue: 'Old Venue', deletedAt: 1, deletedBy: 'mia' });
    await put(`users/mia/mileageTrips/mia1`, { miles: 40 });
    await put(`users/max/mileageTrips/max1`, { miles: 25 });
    await put(`users/ursula/mileageTrips/ursula1`, { miles: 12 });
    await put(`bands/${A}/checklists/mia`, { members: [] });
    await put(`bands/${A}/checklists/ursula`, { members: [] });
    await put(`bands/${A}/unpaidGigs/mia`, { gigIds: [] });
    await put(`bands/${A}/unavailableDates/2027-02-01__mia`, { date: '2027-02-01', name: 'Mia', uid: 'mia' });
    await put(`bands/${A}/settings/stagePlot`, { stagePlotUrl: '' });
    await put(`bands/${A}/invites/ABC123`, { role: 'member', expiresAt: 1 });
    await put(`bands/${A}/fcmTokens/tok-mia`, { uid: 'mia', token: 'tok-mia' });
    await put(`bands/${A}/fcmTokens/tok-ursula`, { uid: 'ursula', token: 'tok-ursula' });
    await put(`users/mia/memberships/${A}`, { role: 'member' });
    await put(`users/ursula/memberships/${A}`, { role: 'member' });
    await put(`users/mia/private/googleAuth`, { refreshToken: 'secret' });
    await put(`sentReminders/x`, { sentAt: 1 });
    // today's flat collections, which must be closed after cutover
    await put(`gigs/legacy`, { venue: 'old' });
    await put(`songs/legacy`, { name: 'old' });
  });
});

const as = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const ok = p => assertSucceeds(p);
const no = p => assertFails(p);
const g = (db, p) => getDoc(doc(db, p));
const s = (db, p, d) => setDoc(doc(db, p), d);

test('nobody signed out can read or write anything', async () => {
  const db = as(null);
  await no(g(db, `bands/${A}`));
  await no(g(db, `bands/${A}/gigs/g1`));
  await no(s(db, `bands/${A}/gigs/new`, { venue: 'x' }));
  await no(g(db, 'users/mia'));
});

test('a signed-in stranger (no band) gets nothing, and cannot join by writing a member doc', async () => {
  const db = as('stan');
  await no(g(db, `bands/${A}`));
  await no(g(db, `bands/${A}/gigs/g1`));
  await no(getDocs(collection(db, `bands/${A}/gigs`)));
  await no(s(db, `bands/${A}/members/stan`, { role: 'owner' }));
  await no(s(db, `bands/${A}/gigs/new`, { venue: 'x' }));
  await no(s(db, `bands/stan-band`, { name: 'Mine', ownerUid: 'stan' }));
});

test("band isolation: A's people cannot touch B, and B's cannot touch A", async () => {
  for (const [uid, other] of [['mia', B], ['olive', B], ['bob', A]]) {
    const db = as(uid);
    await no(g(db, `bands/${other}`));
    await no(g(db, `bands/${other}/gigs/g1`));
    await no(getDocs(collection(db, `bands/${other}/gigs`)));
    await no(s(db, `bands/${other}/gigs/new`, { venue: 'x' }));
    await no(deleteDoc(doc(db, `bands/${other}/gigs/g1`)));
    await no(s(db, `bands/${other}/members/${uid}`, { role: 'owner' }));
  }
});

test('every paid-up role can read the band, its members, gigs, setlists, shared charts and settings', async () => {
  for (const uid of ['olive', 'adam', 'mia']) {
    const db = as(uid);
    await ok(g(db, `bands/${A}`));
    await ok(g(db, `bands/${A}/members/mia`));
    await ok(g(db, `bands/${A}/gigs/g1`));
    await ok(getDocs(collection(db, `bands/${A}/gigs`)));
    await ok(g(db, `bands/${A}/setlists/s1`));
    await ok(g(db, `bands/${A}/songs/shared1`));
    await ok(g(db, `bands/${A}/settings/stagePlot`));
  }
});

test('owner, admin and member can all add, edit and trash gigs, setlists and charts', async () => {
  for (const uid of ['olive', 'adam', 'mia']) {
    const db = as(uid);
    await ok(s(db, `bands/${A}/gigs/new-${uid}`, { venue: 'x', date: '2027-03-01' }));
    await ok(updateDoc(doc(db, `bands/${A}/gigs/g1`), { notes: 'hi' }));
    await ok(s(db, `bands/${A}/setlists/new-${uid}`, { name: 'x' }));
    await ok(s(db, `bands/${A}/songs/new-${uid}`, { name: 'x', uid }));
    await ok(updateDoc(doc(db, `bands/${A}/gigs/new-${uid}`), { deletedAt: Date.now(), deletedBy: uid }));   // "delete" = move to the trash
  }
});

test('LOCKOUT: a person whose own subscription lapsed gets no band content at all', async () => {
  for (const uid of ['ursula', 'carl']) {
    const u = as(uid);
    await no(g(u, `bands/${A}/gigs/g1`));
    await no(getDocs(collection(u, `bands/${A}/gigs`)));
    await no(g(u, `bands/${A}/setlists/s1`));
    await no(g(u, `bands/${A}/songs/shared1`));
    await no(getDocs(collection(u, `bands/${A}/songs`)));
    await no(g(u, `bands/${A}/settings/stagePlot`));
    await no(g(u, `bands/${A}/members/mia`));                       // not even the member list
    await no(g(u, `bands/${A}/unavailableDates/2027-02-01__mia`));
    await no(s(u, `bands/${A}/gigs/new`, { venue: 'x' }));
    await no(updateDoc(doc(u, `bands/${A}/gigs/g1`), { notes: 'x' }));
    await no(deleteDoc(doc(u, `bands/${A}/gigs/g1`)));
    await no(s(u, `bands/${A}/setlists/new`, { name: 'x' }));
    await no(s(u, `bands/${A}/songs/new`, { name: 'x', shared: true, uid }));
    await no(s(u, `bands/${A}/settings/stagePlot`, { stagePlotUrl: 'https://x' }));
    await no(s(u, `bands/${A}/unavailableDates/2027-04-01__${uid}`, { date: '2027-04-01', name: 'U', uid }));
    await no(s(u, `bands/${A}/checklists/${uid}`, { members: [] }));
    await no(g(u, `bands/${A}/invites/ABC123`));
    await no(s(u, `bands/${A}/fcmTokens/new-${uid}`, { uid, token: 'x' }));   // lapsed people stop getting reminders
  }
  // an uncovered admin has no admin powers either
  await no(updateDoc(doc(as('carl'), `bands/${A}`), { name: 'Renamed by Carl' }));
});

test('LOCKOUT leaves exactly what the app needs to say "subscribe to continue"', async () => {
  const u = as('ursula');
  await ok(g(u, `bands/${A}`));                                      // band name and trial info
  await ok(g(u, `bands/${A}/members/ursula`));                       // your own membership record
  await no(g(u, `bands/${A}/members/mia`));
  await ok(g(u, `users/ursula/memberships/${A}`));
});

test('resubscribing is instant: flipping the server flag restores everything', async () => {
  await no(g(as('ursula'), `bands/${A}/gigs/g1`));
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), `bands/${A}/members/ursula`), { covered: true }));
  await ok(g(as('ursula'), `bands/${A}/gigs/g1`));
  await ok(s(as('ursula'), `bands/${A}/gigs/back`, { venue: 'x' }));
  // and a member with no flag at all (trial, just joined) is treated as covered
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), `bands/${A}/members/newbie`), { role: 'member' }));
  await ok(g(as('newbie'), `bands/${A}/gigs/g1`));
});

test("mileage belongs to the person, not the band: only you can read or write it, even the band owner cannot", async () => {
  const mia = as('mia');
  await ok(g(mia, `users/mia/mileageTrips/mia1`));
  await ok(getDocs(collection(mia, `users/mia/mileageTrips`)));
  await ok(s(mia, `users/mia/mileageTrips/new`, { miles: 10, date: '2027-01-01' }));
  await ok(updateDoc(doc(mia, `users/mia/mileageTrips/mia1`), { miles: 41 }));
  await ok(deleteDoc(doc(mia, `users/mia/mileageTrips/mia1`)));
  for (const other of ['max', 'olive', 'adam', 'stan', 'bob']) {            // teammates, band owner, admin, strangers, another band's owner
    const db = as(other);
    await no(g(db, `users/mia/mileageTrips/new`));
    await no(getDocs(collection(db, `users/mia/mileageTrips`)));
    await no(s(db, `users/mia/mileageTrips/forged`, { miles: 1 }));
    await no(updateDoc(doc(db, `users/mia/mileageTrips/new`), { miles: 1 }));
    await no(deleteDoc(doc(db, `users/mia/mileageTrips/new`)));
  }
  await no(g(as(null), `users/mia/mileageTrips/new`));
  // and no band holds mileage any more
  await no(s(mia, `bands/${A}/mileageTrips/x`, { uid: 'mia', miles: 1 }));
  await no(g(mia, `bands/${A}/mileageTrips/anything`));
});

test('mileage does not depend on any band: it is unaffected by lockout, removal, or leaving', async () => {
  // a lapsed member still owns their records; a person in no band at all can still reach theirs
  await ok(g(as('ursula'), `users/ursula/mileageTrips/ursula1`));
  await env.withSecurityRulesDisabled(ctx => deleteDoc(doc(ctx.firestore(), `bands/${A}/members/mia`)));   // mia is removed from the band
  await ok(g(as('mia'), `users/mia/mileageTrips/mia1`));
  await no(g(as('mia'), `bands/${A}/gigs/g1`));                                                            // band content is gone, her mileage is not
  await ok(g(as("stan"), `users/stan/mileageTrips/none`));                                              // someone in no band reads their own (empty) area without error
});

test('checklists and unpaid marks belong to one person', async () => {
  await ok(g(as('mia'), `bands/${A}/checklists/mia`));
  await no(g(as('max'), `bands/${A}/checklists/mia`));
  await no(g(as('olive'), `bands/${A}/checklists/mia`));
  await ok(s(as('mia'), `bands/${A}/checklists/mia`, { members: [1] }));
  await no(s(as('max'), `bands/${A}/checklists/mia`, { members: [1] }));
  await ok(g(as('mia'), `bands/${A}/unpaidGigs/mia`));
  await no(g(as('max'), `bands/${A}/unpaidGigs/mia`));
});

test("band charts belong to the band: every paid-up member can read and fix them, nobody can reassign the author", async () => {
  for (const uid of ['olive', 'adam', 'mia', 'max']) await ok(g(as(uid), `bands/${A}/songs/shared1`));
  await ok(getDocs(collection(as('max'), `bands/${A}/songs`)));                         // a plain list works: everything in here is the band's
  await ok(updateDoc(doc(as('max'), `bands/${A}/songs/shared1`), { key: 'A' }));
  await no(updateDoc(doc(as('max'), `bands/${A}/songs/shared1`), { uid: 'max' }));
  await no(s(as('max'), `bands/${A}/songs/forged`, { name: 'x', uid: 'mia' }));         // a chart is created in your own name
  await ok(s(as('max'), `bands/${A}/songs/mine`, { name: 'x', uid: 'max' }));
  await no(g(as('stan'), `bands/${A}/songs/shared1`));
  await no(g(as('bob'), `bands/${A}/songs/shared1`));                                   // another band
});

test('the chart library belongs to the person: only they can touch it, no band can reach it', async () => {
  const mia = as('mia');
  await ok(g(mia, 'users/mia/charts/lib1'));
  await ok(getDocs(collection(mia, 'users/mia/charts')));
  await ok(s(mia, 'users/mia/charts/new', { name: 'x', type: 'text', content: 'y' }));
  await ok(updateDoc(doc(mia, 'users/mia/charts/lib1'), { name: 'renamed' }));
  await ok(deleteDoc(doc(mia, 'users/mia/charts/new')));
  for (const other of ['max', 'olive', 'adam', 'stan', 'bob']) {
    const db = as(other);
    await no(g(db, 'users/mia/charts/lib1'));
    await no(getDocs(collection(db, 'users/mia/charts')));
    await no(s(db, 'users/mia/charts/forged', { name: 'x' }));
    await no(updateDoc(doc(db, 'users/mia/charts/lib1'), { name: 'stolen' }));
    await no(deleteDoc(doc(db, 'users/mia/charts/lib1')));
  }
  await no(g(as(null), 'users/mia/charts/lib1'));
  // it does not depend on any band: lapsed or removed people keep their own library
  await ok(g(as('ursula'), 'users/ursula/charts/none'));
  await env.withSecurityRulesDisabled(ctx => deleteDoc(doc(ctx.firestore(), `bands/${A}/members/mia`)));
  await ok(g(as('mia'), 'users/mia/charts/lib1'));
});

test('trash: members cannot erase shared content, only move it to Recently deleted; owners and admins erase from there', async () => {
  const stamp = { deletedAt: 5, deletedBy: 'mia' };
  for (const [col, id] of [['gigs', 'g1'], ['setlists', 's1'], ['songs', 'shared1']]) {
    const path = `bands/${A}/${col}/${id}`;
    await no(deleteDoc(doc(as('mia'), path)));                       // a member cannot hard-delete
    await no(deleteDoc(doc(as('adam'), path)));                      // not even an admin, until it is in the trash
    await no(deleteDoc(doc(as('olive'), path)));
    await ok(updateDoc(doc(as('mia'), path), stamp));                // but any member can move it to the trash
    await no(deleteDoc(doc(as('mia'), path)));                       // still cannot erase it
    await ok(updateDoc(doc(as('max'), path), { deletedAt: null, deletedBy: null }));      // and any member can restore it
    await ok(updateDoc(doc(as('max'), path), stamp));
    await ok(deleteDoc(doc(as(col === 'gigs' ? 'adam' : 'olive'), path)));                // owner or admin erases from the trash
  }
  await ok(getDocs(collection(as('mia'), `bands/${A}/gigs`)));       // trashed items are still listable (the Recently deleted screen reads them)
  await no(deleteDoc(doc(as('stan'), `bands/${A}/gigs/trashed1`)));
  await no(deleteDoc(doc(as('ursula'), `bands/${A}/gigs/trashed1`)));   // a locked-out admin-less member has no power either
  await no(deleteDoc(doc(as('carl'), `bands/${A}/gigs/trashed1`)));     // nor a lapsed admin
  await no(deleteDoc(doc(as('bob'), `bands/${A}/gigs/trashed1`)));      // nor another band's owner
  await ok(deleteDoc(doc(as('olive'), `bands/${A}/gigs/trashed1`)));
});

test('membership and roles can only be changed by the server, never from the app', async () => {
  for (const uid of ['olive', 'adam', 'mia', 'stan']) {
    const db = as(uid);
    await no(s(db, `bands/${A}/members/${uid}`, { role: 'owner' }));
    await no(updateDoc(doc(db, `bands/${A}/members/mia`), { role: 'owner' }));
    await no(deleteDoc(doc(db, `bands/${A}/members/max`)));
    await no(s(db, `users/${uid}/memberships/${A}`, { role: 'owner' }));
  }
  // a lapsed person cannot mark themselves covered
  await no(updateDoc(doc(as('ursula'), `bands/${A}/members/ursula`), { covered: true }));
  await no(s(as('ursula'), `bands/${A}/members/ursula`, { role: 'member', covered: true }));
});

test('invites: managers can see them, members cannot, nobody can write them', async () => {
  await ok(g(as('olive'), `bands/${A}/invites/ABC123`));
  await ok(g(as('adam'), `bands/${A}/invites/ABC123`));
  await no(g(as('mia'), `bands/${A}/invites/ABC123`));
  await no(s(as('olive'), `bands/${A}/invites/NEW`, { role: 'owner' }));
  await no(s(as('stan'), `bands/${A}/invites/NEW`, { role: 'owner' }));
});

test('band settings: owner and admins edit name and time zone; only the owner can change the calendar; nobody touches owner, billing or create/delete', async () => {
  for (const uid of ['olive', 'adam']) await ok(updateDoc(doc(as(uid), `bands/${A}`), { name: 'New name', timeZone: 'America/Chicago' }));
  await ok(updateDoc(doc(as('olive'), `bands/${A}`), { calendarId: 'x@group.calendar.google.com' }));          // the owner can
  await ok(updateDoc(doc(as('olive'), `bands/${A}`), { name: 'Both at once', calendarId: 'y@group.calendar.google.com' }));
  // an admin cannot set, change or clear it, alone or mixed in with allowed fields
  await no(updateDoc(doc(as('adam'), `bands/${A}`), { calendarId: 'evil@group.calendar.google.com' }));
  await no(updateDoc(doc(as('adam'), `bands/${A}`), { name: 'ok', calendarId: 'evil@group.calendar.google.com' }));
  await no(updateDoc(doc(as('adam'), `bands/${A}`), { calendarId: '' }));
  await no(updateDoc(doc(as('adam'), `bands/${A}`), { calendarId: deleteField() }));
  // members, lapsed owner-level people, outsiders, other bands' owners cannot change anything
  for (const uid of ['mia', 'ursula', 'carl', 'stan', 'bob']) {
    await no(updateDoc(doc(as(uid), `bands/${A}`), { name: 'Hijack' }));
    await no(updateDoc(doc(as(uid), `bands/${A}`), { calendarId: 'evil@group.calendar.google.com' }));
  }
  for (const uid of ['olive', 'adam']) {
    const db = as(uid);
    await no(updateDoc(doc(db, `bands/${A}`), { ownerUid: 'mallory' }));
    await no(updateDoc(doc(db, `bands/${A}`), { billing: { status: 'active' } }));
    await no(updateDoc(doc(db, `bands/${A}`), { 'billing.trialEndsAt': 9999999999 }));
    await no(updateDoc(doc(db, `bands/${A}`), { name: 'ok', createdAt: 5 }));   // one forbidden key poisons the whole update
    await no(deleteDoc(doc(db, `bands/${A}`)));
  }
  await no(s(as('olive'), 'bands/fresh', { name: 'Fresh', ownerUid: 'olive' }));
});

test('stage plot and settings: managers write, every paid-up member reads', async () => {
  await ok(s(as('adam'), `bands/${A}/settings/stagePlot`, { stagePlotUrl: 'https://x' }));
  await no(s(as('mia'), `bands/${A}/settings/stagePlot`, { stagePlotUrl: 'https://x' }));
  await ok(g(as('mia'), `bands/${A}/settings/stagePlot`));
});

test('availability marks: paid-up members only, and only your own', async () => {
  await ok(g(as('mia'), `bands/${A}/unavailableDates/2027-02-01__mia`));
  await ok(s(as('max'), `bands/${A}/unavailableDates/2027-02-02__max`, { date: '2027-02-02', name: 'Max', uid: 'max' }));
  await no(s(as('max'), `bands/${A}/unavailableDates/2027-02-02__mia`, { date: '2027-02-02', name: 'Mia', uid: 'mia' }));
  await no(deleteDoc(doc(as('max'), `bands/${A}/unavailableDates/2027-02-01__mia`)));
  await ok(deleteDoc(doc(as('mia'), `bands/${A}/unavailableDates/2027-02-01__mia`)));
});

test("push tokens: register your own, never read anyone's back, never register someone else's", async () => {
  await ok(s(as('max'), `bands/${A}/fcmTokens/tok-max`, { uid: 'max', token: 'tok-max' }));
  await no(s(as('max'), `bands/${A}/fcmTokens/tok-evil`, { uid: 'mia', token: 'tok-evil' }));
  await no(g(as('mia'), `bands/${A}/fcmTokens/tok-mia`));
  await no(getDocs(collection(as('mia'), `bands/${A}/fcmTokens`)));
  await no(deleteDoc(doc(as('max'), `bands/${A}/fcmTokens/tok-mia`)));
  await ok(deleteDoc(doc(as('mia'), `bands/${A}/fcmTokens/tok-mia`)));
  await no(s(as('stan'), `bands/${A}/fcmTokens/tok-stan`, { uid: 'stan', token: 'tok-stan' }));
});

test('user documents: you can see your own memberships; secrets and server collections are closed to everyone', async () => {
  await ok(g(as('mia'), `users/mia/memberships/${A}`));
  await ok(getDocs(collection(as('mia'), 'users/mia/memberships')));
  await no(g(as('max'), `users/mia/memberships/${A}`));
  await no(g(as('mia'), 'users/mia/private/googleAuth'));
  await no(s(as('mia'), 'users/mia/private/googleAuth', { refreshToken: 'x' }));
  await no(g(as('olive'), 'sentReminders/x'));
  await no(s(as('olive'), 'stripeCustomers/cus_1', { bandId: A }));
  await no(s(as('olive'), 'stripeEvents/evt_1', { done: true }));
});

test("today's flat collections are closed once these rules are live (the migration's safety net, not a feature)", async () => {
  for (const uid of ['olive', 'mia', 'stan']) {
    const db = as(uid);
    await no(g(db, 'gigs/legacy'));
    await no(g(db, 'songs/legacy'));
    await no(getDocs(collection(db, 'gigs')));
    await no(s(db, 'gigs/new', { venue: 'x' }));
  }
});
