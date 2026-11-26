const crypto = require('crypto');

const TTL = 90000;
const enforcement = () => process.env.COUNTER_SESSION_ENFORCEMENT === 'ENFORCED';
const now = () => Date.now();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const venueRef = (db, id) => db.collection('venues').doc(id);
const result = (code, message) => ({ success: false, code, message });

// Shanghai calendar date is converted to UTC explicitly; cloud runtime timezone is irrelevant.
function ended(ev, time = now()) {
  if (!ev || ev.isClosed || ev.deleting || ev.status === 'cancelled') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !/^\d{2}:\d{2}$/.test(ev.endTime || '')) return true;
  const [h, m] = ev.endTime.split(':').map(Number);
  if (h > 23 || m > 59) return true;
  const offset = (h < 12 ? 24 : 0) * 3600000;
  return time >= Date.parse(ev.date + 'T00:00:00+08:00') + (h * 60 + m) * 60000 + offset;
}

async function log(db, type, venue, caller, extra = {}) {
  // Never log credentials, session IDs, or arbitrary client-supplied strings.
  try {
    const data = {
      type, at: db.serverDate(), venueId: venue && venue._id || '',
      venueName: venue && venue.name || '', staffId: caller && caller._id || '',
      staffName: caller && caller.name || '', role: caller && caller.role || '',
      eventId: extra.eventId || '', eventTitle: extra.eventTitle || '',
      adminId: extra.adminId || '', adminName: extra.adminName || '',
      reason: extra.reason || '', result: extra.result || ''
    };
    if (type === 'COUNTER_INVALID_PASSWORD' || type === 'COUNTER_LOGIN_DENIED') {
      const bucket = Math.floor(now() / 300000);
      const id = hash(type + ':' + (caller && caller._id || '') + ':' + (venue && venue._id || '') + ':' + bucket);
      await db.collection('counter_session_history').doc(id).set({ data });
    } else {
      await db.collection('counter_session_history').add({ data });
    }
  } catch (e) { console.error('[counter-session] audit write failed', type); }
}

async function validate(db, caller, token, eventId, refresh = false) {
  if (!token) return result('COUNTER_SESSION_INVALID', 'Session expired');
  const venueId = token.venueId;
  const sessionId = token.sessionId;
  if (typeof venueId !== 'string' || typeof sessionId !== 'string' || !venueId || !sessionId) return result('COUNTER_SESSION_INVALID', 'Session expired');
  const read = await venueRef(db, venueId).get().catch(() => null);
  const venue = read && read.data;
  const session = venue && venue.counterSession;
  if (venue && venue.revokedCounterSessionHash === hash(sessionId)) {
    return result('COUNTER_PASSWORD_CHANGED', 'The venue password has been changed by the administrator. Please log in again using the new password.');
  }
  if (session && session.idHash === hash(sessionId) && session.version !== (venue.passwordVersion || 0)) {
    return result('COUNTER_PASSWORD_CHANGED', 'The venue password has been changed by the administrator. Please log in again using the new password.');
  }
  if (!session || session.idHash !== hash(sessionId) || session.staffId !== caller._id || session.openid !== caller.lastOpenid ||
      session.version !== (venue.passwordVersion || 0) || session.expiresAt <= now()) {
    return result('COUNTER_SESSION_INVALID', 'Session expired');
  }
  if (eventId && session.eventId !== eventId) return result('COUNTER_SESSION_INVALID', 'Session expired');
  const evRes = await db.collection('events').doc(session.eventId).get().catch(() => null);
  const ev = evRes && evRes.data;
  if (!ev || ended(ev) || (ev.venueId ? ev.venueId !== venueId : ev.venueName !== venue.name)) {
    await release(db, caller, token, 'COUNTER_EVENT_COMPLETED');
    return result('COUNTER_SESSION_INVALID', 'Session expired');
  }
  if (refresh) {
    const updated = await db.collection('venues').where({ _id: venueId, 'counterSession.idHash': session.idHash,
      'counterSession.expiresAt': session.expiresAt, passwordVersion: session.version })
      .update({ data: { 'counterSession.expiresAt': now() + TTL, 'counterSession.lastActiveAt': db.serverDate() } });
    if (!updated.stats || updated.stats.updated !== 1) return result('COUNTER_SESSION_INVALID', 'Session expired');
  }
  return { success: true, venue, session };
}

async function release(db, caller, token, type = 'COUNTER_LOGOUT') {
  if (!token || !token.venueId || !token.sessionId) return result('COUNTER_SESSION_INVALID', 'Session expired');
  const current = await venueRef(db, token.venueId).get().catch(() => null);
  const venue = current && current.data;
  const session = venue && venue.counterSession;
  if (!session || session.idHash !== hash(token.sessionId) || session.staffId !== caller._id) return result('COUNTER_SESSION_INVALID', 'Session expired');
  const updated = await db.collection('venues').where({ _id: token.venueId, 'counterSession.idHash': session.idHash })
    .update({ data: { counterSession: db.command.remove() } });
  if (updated.stats && updated.stats.updated === 1) {
    await log(db, type, venue, caller, { eventId: session.eventId, eventTitle: session.eventTitle, result: 'success' });
    return { success: true };
  }
  return result('COUNTER_SESSION_INVALID', 'Session expired');
}

async function begin(db, caller, password, eventId) {
  if (caller.role !== 'counter' || typeof password !== 'string' || !password.trim() || !eventId) return result('COUNTER_INVALID_PASSWORD', 'Invalid password');
  const matches = await db.collection('venues').where({ password: password.trim() }).limit(2).get();
  const venue = matches.data && matches.data[0];
  if (!venue) { await log(db, 'COUNTER_INVALID_PASSWORD', null, caller, { result: 'denied' }); return result('COUNTER_INVALID_PASSWORD', 'Invalid password'); }
  const evRes = await db.collection('events').doc(eventId).get().catch(() => null);
  const ev = evRes && evRes.data;
  if (!ev || ended(ev) || (ev.venueId ? ev.venueId !== venue._id : ev.venueName !== venue.name)) return result('COUNTER_SESSION_INVALID', 'Event unavailable');
  const old = venue.counterSession;
  if (old && old.expiresAt > now()) {
    await log(db, 'COUNTER_LOGIN_DENIED', venue, caller, { eventId, eventTitle: ev.title, reason: 'occupied', result: 'denied' });
    return result('COUNTER_VENUE_OCCUPIED', 'Venue is currently occupied');
  }
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session = { idHash: hash(sessionId), staffId: caller._id, staffName: caller.name || '',
    openid: caller.lastOpenid, eventId, eventTitle: ev.title || '', version: venue.passwordVersion || 0,
    startedAt: db.serverDate(), lastActiveAt: db.serverDate(), expiresAt: now() + TTL };
  const versionGate = Object.prototype.hasOwnProperty.call(venue, 'passwordVersion') ? venue.passwordVersion : db.command.exists(false);
  const gate = { _id: venue._id, password: password.trim(), passwordVersion: versionGate };
  gate['counterSession.expiresAt'] = db.command.lte(now());
  const vacant = { _id: venue._id, password: password.trim(), passwordVersion: versionGate,
    counterSession: db.command.exists(false) };
  // CAS against both the password/version and the occupancy; no read-then-write race.
  let updated = await db.collection('venues').where(old ? gate : vacant).update({ data: { counterSession: session } });
  if (!updated.stats || updated.stats.updated !== 1) {
    await log(db, 'COUNTER_LOGIN_DENIED', venue, caller, { eventId, eventTitle: ev.title, reason: 'occupied_or_password_changed', result: 'denied' });
    return result('COUNTER_VENUE_OCCUPIED', 'Venue is currently occupied');
  }
  if (old && old.expiresAt <= now()) await log(db, 'COUNTER_SESSION_EXPIRED', venue,
    { _id: old.staffId, name: old.staffName, role: 'counter' }, { eventId: old.eventId, eventTitle: old.eventTitle, reason: 'inactivity', result: 'expired' });
  await log(db, 'COUNTER_LOGIN_SUCCESS', venue, caller, { eventId, eventTitle: ev.title, result: 'success' });
  return { success: true, venue: { _id: venue._id, name: venue.name }, event: ev, sessionId };
}

module.exports = { enforcement, ended, log, begin, validate, release, result };
