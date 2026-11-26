const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function valid(db, caller, token) {
  if (!token || !token.venueId || !token.sessionId) return false;
  const read = await db.collection('venues').doc(token.venueId).get().catch(() => null);
  const venue = read && read.data;
  const session = venue && venue.counterSession;
  if (!session || session.idHash !== hash(token.sessionId) || session.staffId !== caller._id ||
      session.openid !== caller.lastOpenid || session.version !== (venue.passwordVersion || 0) ||
      session.expiresAt <= Date.now()) return false;
  const event = await db.collection('events').doc(session.eventId).get().catch(() => null);
  const ev = event && event.data;
  if (!ev || ev.isClosed || ev.deleting || ev.status === 'cancelled' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !/^\d{2}:\d{2}$/.test(ev.endTime || '')) return false;
  const [h, m] = ev.endTime.split(':').map(Number);
  return h <= 23 && m <= 59 && Date.now() < Date.parse(ev.date + 'T00:00:00+08:00') +
    (h * 60 + m) * 60000 + (h < 12 ? 86400000 : 0) &&
    (ev.venueId ? ev.venueId === venue._id : ev.venueName === venue.name);
}
module.exports = { valid };
