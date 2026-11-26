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
module.exports = { enforced, validate };
