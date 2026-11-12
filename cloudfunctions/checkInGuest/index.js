const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { retentionReason } = require('./freeRegistrationPolicy');

async function getCallerStaff(db) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return null;
  const res = await db.collection('staff').where({ lastOpenid: openid }).limit(1).get();
  return (res.data && res.data.length > 0) ? res.data[0] : null;
}

// Absolute-ms window of an event: date "YYYY-MM-DD" + startTime/endTime "HH:MM".
// Date.UTC on both sides keeps the comparison timezone-independent, and an
// endTime earlier than startTime means the party crosses midnight (+1 day).
function eventWindowMs(event) {
  if (!event || !event.date || !event.startTime || !event.endTime) return null;
  const parse = (date, time, dayShift) => {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return Date.UTC(y, m - 1, d + (dayShift || 0), hh, mm, 0);
  };
  const start = parse(event.date, event.startTime);
  let end = parse(event.date, event.endTime);
  if (end <= start) end = parse(event.date, event.endTime, 1);
  return { start, end };
}

const overlaps = (a, b) => !!(a && b && a.start < b.end && b.start < a.end);

exports.main = async (event) => {
  const { registrationId, arrivedAt } = event;
  const caller = await getCallerStaff(db);
  if (!caller) {
    return { success: false, message: 'Unauthorized' };
  }
  try {
    const regRes = await db.collection('registrations').doc(registrationId).get();
    const reg = regRes && regRes.data;
    if (!reg) return { success: false, message: 'Registration not found' };

    await db.collection('registrations').doc(registrationId).update({
      data: {
        arrivedAt: reg.arrivedAt || arrivedAt,
        checkedInAt: reg.checkedInAt || db.serverDate()
      }
    });

    // One guest — one simultaneous venue: marking this guest at an event
    // supersedes their arrival mark on any OTHER event whose time window
    // overlaps this one (they physically moved venues). Marks on events that
    // don't overlap (guest stayed until the end, then went to the next one)
    // are kept — both count.
    let supersededEvents = [];
    const thisEventRes = await db.collection('events').doc(reg.eventId).get().catch(() => null);
    const thisWindow = eventWindowMs(thisEventRes && thisEventRes.data);
    if (thisWindow && reg._openid) {
      const othersRes = await db.collection('registrations')
        .where({ _openid: reg._openid })
        .limit(1000)
        .get();
      // Same-eventId excluded: a legacy duplicate registration of the SAME
      // event must never clear its own event's mark.
      const marked = (othersRes.data || []).filter(r =>
        r.arrivedAt && r._id !== registrationId && r.eventId !== reg.eventId
      );
      const eventIds = Array.from(new Set(marked.map(r => r.eventId)));
      const eventDocs = {};
      await Promise.all(eventIds.map(id =>
        db.collection('events').doc(id).get()
          .then(res => { eventDocs[id] = res.data; })
          .catch(() => {})
      ));
      const toClear = marked.filter(r => !retentionReason(r, eventDocs[r.eventId], Date.now()) &&
        overlaps(thisWindow, eventWindowMs(eventDocs[r.eventId])));
      await Promise.all(toClear.map(r =>
        db.collection('registrations').doc(r._id).update({
          data: { arrivedAt: null, checkedInAt: null }
        })
      ));
      supersededEvents = toClear.map(r =>
        (eventDocs[r.eventId] && eventDocs[r.eventId].title) || r.eventId
      );
    }

    return { success: true, supersededEvents };
  } catch (e) {
    return { success: false, error: e.message };
  }
};
