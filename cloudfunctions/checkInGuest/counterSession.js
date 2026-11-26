const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const enforced = () => process.env.COUNTER_SESSION_ENFORCEMENT === 'ENFORCED';
function ended(ev) {
  if (!ev || ev.isClosed || ev.deleting || ev.status === 'cancelled' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !/^\d{2}:\d{2}$/.test(ev.endTime || '')) return true;
  const [hour, minute] = ev.endTime.split(':').map(Number);
  if (hour > 23 || minute > 59) return true;
  return Date.now() >= Date.parse(ev.date + 'T00:00:00+08:00') +
    (hour * 60 + minute) * 60000 + (hour < 12 ? 86400000 : 0);
}
async function validate(db, caller, token, eventId) {
  if (!token || !token.venueId || !token.sessionId) return false;
  const read = await db.collection('venues').doc(token.venueId).get().catch(() => null);
  const venue = read && read.data;
  const session = venue && venue.counterSession;
  if (!session || session.idHash !== hash(token.sessionId) || session.staffId !== caller._id ||
      session.openid !== caller.lastOpenid || session.version !== (venue.passwordVersion || 0) ||
      session.expiresAt <= Date.now() || session.eventId !== eventId) return false;
  const evRead = await db.collection('events').doc(eventId).get().catch(() => null);
  const ev = evRead && evRead.data;
  return !!(ev && !ended(ev) && (ev.venueId ? ev.venueId === venue._id : ev.venueName === venue.name));
}
async function checkIn(db, caller, token, registrationId, arrivedAt) {
  if (!token || typeof token.venueId !== 'string' || typeof token.sessionId !== 'string') {
    return { success: false, code: 'COUNTER_SESSION_INVALID', message: 'Session expired' };
  }
  try {
    return await db.runTransaction(async tx => {
      const staff = (await tx.collection('staff').doc(caller._id).get()).data;
      if (!staff || staff.role !== 'counter' || staff.lastOpenid !== caller.lastOpenid) throw new Error('COUNTER_SESSION_INVALID');
      const reg = (await tx.collection('registrations').doc(registrationId).get()).data;
      if (!reg) throw new Error('COUNTER_SESSION_INVALID');
      const venue = (await tx.collection('venues').doc(token.venueId).get()).data;
      const session = venue && venue.counterSession;
      if (!session || session.idHash !== hash(token.sessionId) || session.staffId !== caller._id ||
          session.openid !== caller.lastOpenid || session.version !== (venue.passwordVersion || 0) ||
          session.expiresAt <= Date.now() || session.eventId !== reg.eventId) throw new Error('COUNTER_SESSION_INVALID');
      const ev = (await tx.collection('events').doc(reg.eventId).get()).data;
      if (ended(ev) || (ev.venueId ? ev.venueId !== venue._id : ev.venueName !== venue.name)) throw new Error('COUNTER_SESSION_INVALID');
      await tx.collection('venues').doc(venue._id).update({ data: { 'counterSession.guardAt': db.serverDate() } });
      await tx.collection('staff').doc(staff._id).update({ data: { counterSessionGuardAt: db.serverDate() } });
      await tx.collection('events').doc(reg.eventId).update({ data: { counterSessionGuardAt: db.serverDate() } });
      await tx.collection('registrations').doc(registrationId).update({ data: {
        arrivedAt: reg.arrivedAt || arrivedAt, checkedInAt: reg.checkedInAt || db.serverDate()
      } });
      if (session.expiresAt <= Date.now()) throw new Error('COUNTER_SESSION_INVALID');
      return { success: true, supersededEvents: [] };
    });
  } catch (e) {
    return { success: false, code: e.message === 'COUNTER_SESSION_INVALID' ? 'COUNTER_SESSION_INVALID' : 'COUNTER_OPERATION_RETRY',
      message: e.message === 'COUNTER_SESSION_INVALID' ? 'Session expired' : 'Operation could not be completed. Please retry.' };
  }
}
module.exports = { enforced, validate, checkIn };
