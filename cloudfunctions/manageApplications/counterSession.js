const crypto = require('crypto');

const enforcement = () => process.env.COUNTER_SESSION_ENFORCEMENT === 'ENFORCED';
const now = () => Date.now();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const venueRef = (db, id) => db.collection('venues').doc(id);
const result = (code, message) => ({ success: false, code, message });
async function optionalDoc(ref) {
  try { return await ref.get(); }
  catch (e) {
    if (String(e && e.message || e).includes('does not exist')) return { data: null };
    throw e; // A database outage must not revoke someone else's session.
  }
}

// Shanghai calendar date is converted to UTC explicitly; cloud runtime timezone is irrelevant.
function eventEndMs(ev) {
  const [h, m] = ev.endTime.split(':').map(Number);
  return Date.parse(ev.date + 'T00:00:00+08:00') + (h * 60 + m) * 60000 + (h < 12 ? 86400000 : 0);
}
function ended(ev, time = now()) {
  if (!ev || ev.isClosed || ev.deleting || ev.status === 'cancelled') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !/^\d{2}:\d{2}$/.test(ev.endTime || '')) return true;
  const [h, m] = ev.endTime.split(':').map(Number);
  if (h > 23 || m > 59) return true;
  return time >= eventEndMs(ev);
}

function auditData(db, type, venue, caller, extra = {}) {
  // Fixed fields only: no passwords, tokens, client-supplied explanations or PII.
  return { type, at: db.serverDate(), venueId: venue && venue._id || '',
    venueName: venue && venue.name || '', staffId: caller && caller._id || '',
    staffName: caller && caller.name || '', role: caller && caller.role || '',
    eventId: extra.eventId || '', eventTitle: extra.eventTitle || '',
    adminId: extra.adminId || '', adminName: extra.adminName || '',
    reason: extra.reason || '', result: extra.result || '',
    actorId: caller && caller._id || extra.adminId || '', actorName: caller && caller.name || extra.adminName || '',
    actorRole: caller && caller.role || (extra.adminId ? 'admin' : 'system'),
    sessionId: extra.sessionId || '', targetId: '', targetName: '', details: {} };
}

async function log(db, type, venue, caller, extra = {}) {
  const data = auditData(db, type, venue, caller, extra);
  if (type === 'COUNTER_INVALID_PASSWORD' || type === 'COUNTER_LOGIN_DENIED') {
    const id = hash(type + ':' + (caller && caller._id || '') + ':' + (venue && venue._id || '') + ':' + Math.floor(now() / 300000));
    await db.collection('counter_session_history').doc(id).set({ data });
  } else {
    await db.collection('counter_session_history').add({ data });
  }
}

// Every protected mutation writes the same venue and event documents as revocation
// and closure. Snapshot-isolation read/write conflicts then abort stale operations.
async function mutate(db, caller, token, eventId, change) {
  if (!token || typeof token.venueId !== 'string' || typeof token.sessionId !== 'string') return result('COUNTER_SESSION_INVALID', 'Session expired');
  try {
    return await db.runTransaction(async tx => {
      const staff = (await tx.collection('staff').doc(caller._id).get()).data;
      if (!staff || staff.role !== 'counter' || staff.lastOpenid !== caller.lastOpenid) throw new Error('COUNTER_SESSION_INVALID');
      const venue = (await tx.collection('venues').doc(token.venueId).get()).data;
      const session = venue && venue.counterSession;
      if (!session || session.idHash !== hash(token.sessionId) || session.staffId !== caller._id ||
          session.openid !== caller.lastOpenid || session.version !== (venue.passwordVersion || 0) ||
          session.eventId !== eventId) throw new Error('COUNTER_SESSION_INVALID');
      const ev = (await tx.collection('events').doc(eventId).get()).data;
      if (ended(ev) || (ev.venueId ? ev.venueId !== venue._id : ev.venueName !== venue.name)) throw new Error('COUNTER_SESSION_INVALID');
      await tx.collection('venues').doc(venue._id).update({ data: { 'counterSession.guardAt': db.serverDate() } });
      await tx.collection('staff').doc(staff._id).update({ data: { counterSessionGuardAt: db.serverDate() } });
      await tx.collection('events').doc(eventId).update({ data: { counterSessionGuardAt: db.serverDate() } });
      const response = await change(tx, session, venue, ev);
      return response;
    });
  } catch (e) {
    if (e.message === 'COUNTER_SESSION_INVALID') return result('COUNTER_SESSION_INVALID', 'Session expired');
    // A failed transaction (including a write conflict) never falls back to an unguarded write.
    return result('COUNTER_OPERATION_RETRY', 'Operation could not be completed. Please retry.');
  }
}

async function validate(db, caller, token, eventId, refresh = false) {
  if (!token || !caller || caller.role !== 'counter') return result('COUNTER_SESSION_INVALID', 'Session expired');
  const venueId = token.venueId;
  const sessionId = token.sessionId;
  if (typeof venueId !== 'string' || typeof sessionId !== 'string' || !venueId || !sessionId) return result('COUNTER_SESSION_INVALID', 'Session expired');
  let read;
  try { read = await optionalDoc(venueRef(db, venueId)); }
  catch (_) { return result('COUNTER_OPERATION_RETRY', 'Session check unavailable. Please retry.'); }
  const venue = read && read.data;
  const session = venue && venue.counterSession;
  if (venue && venue.revokedCounterSessionHash === hash(sessionId)) {
    return result('COUNTER_PASSWORD_CHANGED', 'The venue password has been changed by the administrator. Please log in again using the new password.');
  }
  if (session && session.idHash === hash(sessionId) && session.version !== (venue.passwordVersion || 0)) {
    return result('COUNTER_PASSWORD_CHANGED', 'The venue password has been changed by the administrator. Please log in again using the new password.');
  }
  if (!session || session.idHash !== hash(sessionId) || session.staffId !== caller._id || session.openid !== caller.lastOpenid ||
      session.version !== (venue.passwordVersion || 0)) {
    return result('COUNTER_SESSION_INVALID', 'Session expired');
  }
  if (eventId && session.eventId !== eventId) return result('COUNTER_SESSION_INVALID', 'Session expired');
  let evRes;
  try { evRes = await optionalDoc(db.collection('events').doc(session.eventId)); }
  catch (_) { return result('COUNTER_OPERATION_RETRY', 'Session check unavailable. Please retry.'); }
  const ev = evRes && evRes.data;
  if (!ev || ended(ev) || (ev.venueId ? ev.venueId !== venueId : ev.venueName !== venue.name)) {
    const closed = await release(db, caller, token, 'COUNTER_EVENT_COMPLETED');
    if (!closed.success && closed.code !== 'COUNTER_SESSION_INVALID') return closed;
    return result('COUNTER_SESSION_INVALID', 'Session expired');
  }
  if (refresh) {
    try {
      await db.runTransaction(async tx => {
        const fresh = (await tx.collection('venues').doc(venueId).get()).data;
        const current = fresh && fresh.counterSession;
        if (!current || current.idHash !== hash(sessionId) || current.staffId !== caller._id ||
            current.openid !== caller.lastOpenid || current.version !== (fresh.passwordVersion || 0)) throw new Error('COUNTER_SESSION_INVALID');
        const currentEvent = (await tx.collection('events').doc(current.eventId).get()).data;
        if (ended(currentEvent) || (currentEvent.venueId ? currentEvent.venueId !== venueId
          : currentEvent.venueName !== fresh.name)) throw new Error('COUNTER_SESSION_INVALID');
        await tx.collection('venues').doc(venueId).update({ data: {
          'counterSession.expiresAt': eventEndMs(currentEvent), 'counterSession.lastActiveAt': db.serverDate()
        } });
      });
    } catch (e) { return e.message === 'COUNTER_SESSION_INVALID'
      ? result('COUNTER_SESSION_INVALID', 'Session expired')
      : result('COUNTER_OPERATION_RETRY', 'Session check unavailable. Please retry.'); }
  }
  return { success: true, venue, session, event: ev };
}

async function release(db, caller, token, type = 'COUNTER_LOGOUT') {
  if (!token || !token.venueId || !token.sessionId) return result('COUNTER_SESSION_INVALID', 'Session expired');
  const auditId = crypto.randomBytes(16).toString('hex');
  try {
    return await db.runTransaction(async tx => {
      const venue = (await tx.collection('venues').doc(token.venueId).get()).data;
      const session = venue && venue.counterSession;
      if (!session || session.idHash !== hash(token.sessionId) || session.staffId !== caller._id) throw new Error('COUNTER_SESSION_INVALID');
      await tx.collection('venues').doc(token.venueId).update({ data: { counterSession: db.command.remove() } });
      await tx.collection('counter_session_history').doc(auditId).set({ data: auditData(db, type, venue, caller,
        { eventId: session.eventId, eventTitle: session.eventTitle, sessionId: session.idHash, result: 'success' }) });
      return { success: true };
    });
  } catch (e) {
    return result(e.message === 'COUNTER_SESSION_INVALID' ? 'COUNTER_SESSION_INVALID' : 'COUNTER_OPERATION_RETRY',
      'Session could not be ended. Please retry.');
  }
}

async function begin(db, caller, password, eventId) {
  if (caller.role !== 'counter' || typeof password !== 'string' || !password.trim() || !eventId) return result('COUNTER_INVALID_PASSWORD', 'Invalid password');
  const matches = await db.collection('venues').where({ password: password.trim() }).limit(2).get();
  const venue = matches.data && matches.data[0];
  if (!venue) { await log(db, 'COUNTER_INVALID_PASSWORD', null, caller, { result: 'denied' }); return result('COUNTER_INVALID_PASSWORD', 'Invalid password'); }
  const evRes = await db.collection('events').doc(eventId).get().catch(() => null);
  const ev = evRes && evRes.data;
  if (!ev || ended(ev) || (ev.venueId ? ev.venueId !== venue._id : ev.venueName !== venue.name)) return result('COUNTER_SESSION_INVALID', 'Event unavailable');
  const sessionId = crypto.randomBytes(32).toString('hex');
  try {
    return await db.runTransaction(async tx => {
      const staff = (await tx.collection('staff').doc(caller._id).get()).data;
      if (!staff || staff.role !== 'counter' || staff.lastOpenid !== caller.lastOpenid) throw new Error('COUNTER_SESSION_INVALID');
      const current = (await tx.collection('venues').doc(venue._id).get()).data;
      if (!current || current.password !== password.trim()) throw new Error('COUNTER_INVALID_PASSWORD');
      const activeEvent = (await tx.collection('events').doc(eventId).get()).data;
      if (ended(activeEvent) || (activeEvent.venueId ? activeEvent.venueId !== current._id : activeEvent.venueName !== current.name)) throw new Error('COUNTER_SESSION_INVALID');
      const old = current.counterSession;
      const sameOwner = old && old.staffId === staff._id && old.openid === staff.lastOpenid;
      let oldEventEnded = false;
      let oldActive = !!(old && old.eventId && old.staffId && old.openid &&
        /^[a-f0-9]{64}$/.test(old.idHash || '') &&
        old.version === (current.passwordVersion || 0));
      if (oldActive) {
        const oldEvent = await optionalDoc(tx.collection('events').doc(old.eventId));
        oldEventEnded = !oldEvent || !oldEvent.data || ended(oldEvent.data);
        oldActive = !!(oldEvent && oldEvent.data && !ended(oldEvent.data) &&
          (oldEvent.data.venueId ? oldEvent.data.venueId === current._id : oldEvent.data.venueName === current.name));
        if (oldActive && !sameOwner) {
          const oldStaff = await optionalDoc(tx.collection('staff').doc(old.staffId));
          oldActive = !!(oldStaff && oldStaff.data && oldStaff.data.role === 'counter' &&
            oldStaff.data.lastOpenid === old.openid);
        }
      }
      if (oldActive && !sameOwner) throw new Error('COUNTER_VENUE_OCCUPIED');
      const session = { idHash: hash(sessionId), staffId: caller._id, staffName: caller.name || '',
        openid: caller.lastOpenid, eventId, eventTitle: activeEvent.title || '', version: current.passwordVersion || 0,
        startedAt: db.serverDate(), lastActiveAt: db.serverDate(), expiresAt: eventEndMs(activeEvent) };
      await tx.collection('venues').doc(current._id).update({ data: { counterSession: session } });
      await tx.collection('staff').doc(staff._id).update({ data: { counterSessionGuardAt: db.serverDate() } });
      if (old && old.idHash) {
        const replaced = sameOwner && oldActive;
        const endType = replaced ? 'COUNTER_LOGOUT' : oldEventEnded ? 'COUNTER_EVENT_COMPLETED' : 'COUNTER_SESSION_EXPIRED';
        await tx.collection('counter_session_history').doc(hash('ended:' + old.idHash)).set({ data:
          auditData(db, endType, current,
            { _id: old.staffId, name: old.staffName, role: 'counter' },
            { eventId: old.eventId, eventTitle: old.eventTitle, sessionId: old.idHash,
              reason: replaced ? 'replaced' : oldEventEnded ? 'event_completed' : 'invalid', result: 'success' }) });
      }
      await tx.collection('counter_session_history').doc(hash('login:' + session.idHash)).set({ data:
        auditData(db, 'COUNTER_LOGIN_SUCCESS', current, caller, { eventId, eventTitle: activeEvent.title,
          sessionId: session.idHash, result: 'success' }) });
      return { success: true, venue: { _id: current._id, name: current.name }, sessionId };
    });
  } catch (e) {
    if (e.message === 'COUNTER_VENUE_OCCUPIED') {
      await log(db, 'COUNTER_LOGIN_DENIED', venue, caller, { eventId, eventTitle: ev.title, reason: 'occupied', result: 'denied' });
      return result('COUNTER_VENUE_OCCUPIED', 'Venue is currently occupied');
    }
    return result('COUNTER_OPERATION_RETRY', 'Login could not be completed. Please retry.');
  }
}

module.exports = { enforcement, ended, auditData, log, begin, validate, release, mutate, result };
