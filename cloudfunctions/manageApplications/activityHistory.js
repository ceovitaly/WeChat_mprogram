const crypto = require('crypto');
const { ended } = require('./counterSession');
const HISTORY = 'counter_session_history';
const id = () => crypto.randomBytes(16).toString('hex');
const safe = value => typeof value === 'string' ? value.slice(0, 160) : value;
const BUSINESS = ['title', 'date', 'startTime', 'endTime', 'venueId', 'venueName', 'partyCapacity',
  'afterPartyCapacity', 'lateAfterPartyCapacity', 'hasFreeEntry', 'freeTicketsLimit', 'freeUntil',
  'hasPaidPackages', 'eventsOnly', 'isFree', 'isPaid', 'status', 'isClosed'];
function changes(before, after) {
  const out = {};
  for (const key of BUSINESS) {
    if (JSON.stringify(before && before[key]) !== JSON.stringify(after && after[key])) {
      out[key] = { from: before && before[key] === undefined ? null : before && before[key],
        to: after && after[key] === undefined ? null : after && after[key] };
    }
  }
  return out;
}
function record(db, type, actor, venue, event, target, extra = {}) {
  return { type, at: db.serverDate(), venueId: venue && venue._id || event && event.venueId || '',
    venueName: safe(venue && venue.name || event && event.venueName || ''),
    eventId: event && event._id || '', eventTitle: safe(event && event.title || ''),
    eventDate: event && event.date || '', startTime: event && event.startTime || '', endTime: event && event.endTime || '',
    actorId: actor && actor._id || '', actorName: safe(actor && actor.name || ''),
    actorRole: actor && actor.role || 'system', staffId: actor && actor.role === 'counter' ? actor._id : '',
    staffName: actor && actor.role === 'counter' ? safe(actor.name || '') : '',
    targetId: target && target._id || '', targetName: safe(target && target.name || ''),
    sessionId: extra.sessionId || '', result: extra.result || 'success',
    details: extra.details || {}, reason: extra.reason || '' };
}
async function append(tx, db, type, actor, venue, event, target, extra = {}, recordId = id()) {
  await tx.collection(HISTORY).doc(recordId).set({ data: record(db, type, actor, venue, event, target, extra) });
}
function stamp(value) {
  const v = value && value.$date !== undefined ? value.$date : value;
  return new Date(v || 0).getTime();
}
const pageSize = n => Math.min(50, Math.max(1, Number(n) || 20));
const offset = n => Math.max(0, Math.min(100000, Number(n) || 0));
const eventState = e => e.deleting ? 'Deleting' : e.status === 'cancelled' ? 'Cancelled'
  : (e.isClosed || e.status === 'closed' || ended(e)) ? 'Completed' : 'Active';
async function venuePage(db, request) {
  const size = pageSize(request.limit), skip = offset(request.offset);
  const rows = await db.collection('venues').orderBy('name', 'asc').skip(skip).limit(size).get();
  const result = await Promise.all((rows.data || []).map(async v => {
    const [events, latest, active, sessionEvent] = await Promise.all([
      db.collection('events').where({ venueId: v._id }).count(),
      db.collection('events').where({ venueId: v._id }).orderBy('date', 'desc').field({ date: true }).limit(1).get(),
      db.collection('events').where({ venueId: v._id, status: 'active', isClosed: db.command.neq(true) }).count(),
      v.counterSession && v.counterSession.eventId
        ? db.collection('events').doc(v.counterSession.eventId).get().catch(() => null) : null
    ]);
    return { id: v._id, name: v.name, photo: v.coverImage || v.logo || (v.galleryImages || [])[0] || '',
      eventCount: events.total, lastEventDate: (latest.data || [])[0]?.date || '',
      activeEvents: active.total,
      occupied: !!(v.counterSession && v.counterSession.version === (v.passwordVersion || 0) &&
        sessionEvent && sessionEvent.data && !ended(sessionEvent.data) &&
        (sessionEvent.data.venueId ? sessionEvent.data.venueId === v._id : sessionEvent.data.venueName === v.name)) };
  }));
  if (skip === 0) {
    const removed = await db.collection(HISTORY).where({ type: 'VENUE_DELETED' }).limit(1000).get();
    const known = new Set(result.map(v => v.id));
    for (const log of removed.data || []) {
      if (!log.venueId || known.has(log.venueId)) continue;
      known.add(log.venueId);
      result.push({ id: log.venueId, name: log.venueName, photo: '', eventCount: 0,
        lastEventDate: '', activeEvents: 0, occupied: false, historical: true });
    }
  }
  if (skip === 0) result.unshift({ id: '__global__', name: 'Organisation', photo: '', eventCount: 0,
    lastEventDate: '', activeEvents: 0, occupied: false, global: true });
  return { success: true, data: result, hasMore: (rows.data || []).length === size,
    nextOffset: skip + (rows.data || []).length };
}
async function eventPage(db, request) {
  const size = pageSize(request.limit), skip = offset(request.offset);
  const venueId = request.venueId;
  if (!venueId || typeof venueId !== 'string') return { success: false, message: 'Venue required' };
  const venue = (await db.collection('venues').doc(venueId).get().catch(() => null))?.data;
  const where = venue ? db.command.or([{ venueId }, { venueName: venue.name }]) : { venueId };
  const rows = await db.collection('events').where(where).orderBy('date', 'desc').skip(skip).limit(size).get();
  const result = await Promise.all((rows.data || []).map(async e => {
    const summary = await db.collection('reports').where({ eventId: e._id }).limit(1).get().catch(() => ({ data: [] }));
    const report = (summary.data || [])[0] || {};
    const frozen = e.archived && report.listReport && report.listReport.header;
    const _ = db.command;
    const [total, entered, noScan, cancellations] = await Promise.all([
      e.archived ? null : db.collection('registrations').where({ eventId: e._id }).count(),
      e.archived ? null : db.collection('registrations').where({ eventId: e._id, arrivedAt: _.neq(null) }).count(),
      e.archived ? null : db.collection('registrations').where(_.and([
        { eventId: e._id, arrivedAt: _.neq(null) },
        _.or([{ scannedAt: _.eq(null) }, { scannedAt: _.exists(false) }])
      ])).count(),
      db.collection(HISTORY).where({ eventId: e._id, type: 'GUEST_REGISTRATION_CANCELLED' }).count()
    ]);
    return { id: e._id, title: e.title, date: e.date, startTime: e.startTime, endTime: e.endTime,
      status: eventState(e), venueId, venueName: e.venueName || venue && venue.name || '',
      totalGuests: e.archived ? (frozen ? frozen.total : null) : total.total,
      arrived: e.archived ? (frozen ? frozen.arrived : null) : entered.total,
      noScan: e.archived ? null : noScan.total, cancelled: cancellations.total || 0, historical: !!e.archived };
  }));
  if (skip === 0) {
    const deleted = await db.collection(HISTORY).where({ venueId, type: 'EVENT_DELETED' }).limit(1000).get();
    const seen = new Set(result.map(e => e.id));
    for (const log of deleted.data || []) {
      if (!log.eventId || seen.has(log.eventId)) continue;
      seen.add(log.eventId);
      result.push({ id: log.eventId, title: log.eventTitle, date: log.eventDate,
        startTime: log.startTime || '', endTime: log.endTime || '', status: 'Deleted',
        venueId, venueName: log.venueName, totalGuests: null, arrived: null,
        noScan: null, cancelled: null, historical: true });
    }
    result.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  return { success: true, data: result, hasMore: (rows.data || []).length === size,
    nextOffset: skip + (rows.data || []).length };
}
async function timeline(db, request) {
  const size = pageSize(request.limit), skip = offset(request.offset);
  if (typeof request.venueId !== 'string' || !request.venueId) return { success: false, message: 'Venue required' };
  let where = { venueId: request.venueId === '__global__' ? '' : request.venueId };
  if (request.eventId) where.eventId = request.eventId;
  else where.eventId = '';
  if (request.role && request.role !== 'All') {
    if (request.role === 'Security') where.type = db.command.in(['COUNTER_LOGIN_SUCCESS','COUNTER_LOGIN_DENIED','COUNTER_INVALID_PASSWORD','COUNTER_LOGOUT','COUNTER_SESSION_EXPIRED','COUNTER_FORCE_LOGOUT','COUNTER_ACCESS_REVOKED','VENUE_PASSWORD_CHANGED']);
    else where.actorRole = request.role.toLowerCase();
  }
  if (request.from || request.to) where.at = db.command.gte(new Date(request.from || 0)).and(db.command.lte(new Date(request.to || Date.now())));
  const q = String(request.search || '').trim().slice(0, 80);
  if (q) {
    const pattern = db.RegExp({ regexp: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
    where = db.command.and([where, db.command.or([
      { actorName: pattern }, { staffName: pattern }, { targetName: pattern }, { eventTitle: pattern }
    ])]);
  }
  const rows = await db.collection(HISTORY).where(where).orderBy('at', 'desc').skip(skip).limit(size).get();
  return { success: true, data: rows.data || [], hasMore: (rows.data || []).length === size,
    nextOffset: skip + (rows.data || []).length };
}
async function sessions(db, request) {
  const size = pageSize(request.limit), skip = offset(request.offset);
  const where = { type: 'COUNTER_LOGIN_SUCCESS' };
  if (request.venueId) where.venueId = request.venueId;
  const res = await db.collection(HISTORY).where(where).orderBy('at','desc').skip(skip).limit(size).get();
  const rows = await Promise.all((res.data || []).map(async start => {
    if (!start.sessionId) return null;
    const logs = await db.collection(HISTORY).where({ sessionId: start.sessionId }).orderBy('at', 'desc').limit(1000).get();
    const all = logs.data || [];
    const finish = all.find(r => ['COUNTER_LOGOUT','COUNTER_SESSION_EXPIRED','COUNTER_FORCE_LOGOUT',
      'COUNTER_EVENT_COMPLETED','COUNTER_ACCESS_REVOKED','VENUE_PASSWORD_CHANGED'].includes(r.type));
    return { sessionId: start.sessionId, staffName: start.actorName || start.staffName, venueName: start.venueName,
      eventTitle: start.eventTitle, startedAt: start.at, endedAt: finish && finish.at || null,
      durationMinutes: finish ? Math.max(0, Math.floor((stamp(finish.at) - stamp(start.at)) / 60000)) : null,
      endReason: finish && (finish.reason || finish.type) || 'Active', incomplete: all.length === 1000,
      qr: all.filter(r => r.type === 'QR_CHECKIN').length,
      manual: all.filter(r => r.type === 'MANUAL_CHECKIN' || r.type === 'MANUAL_CHECKIN_NO_SCAN').length,
      unchecked: all.filter(r => r.type === 'GUEST_UNCHECKED').length,
      removed: all.filter(r => r.type === 'REGISTRATION_REMOVED').length };
  }));
  return { success: true, data: rows.filter(Boolean), hasMore: (res.data || []).length === size, nextOffset: skip + (res.data || []).length };
}
module.exports = { id, changes, record, append, venuePage, eventPage, timeline, sessions };
