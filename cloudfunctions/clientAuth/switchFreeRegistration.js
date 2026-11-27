'use strict';

const crypto = require('crypto');
const { isFreeRegistration, eventHasFinished, attendanceMs, retentionReason, timestampMs } = require('./freeRegistrationPolicy');

function policyError(code, message) {
  const error = new Error(message);
  error.policyCode = code;
  return error;
}

// Candidate IDs only: an event keeps its official Shanghai calendar date even
// when the party runs past midnight. Resolve legacy rows lacking eventDate by
// eventId, never by a global guest cursor or a recent-history date range.
async function sameDateCandidates(db, openid, eventId, date) {
  const ids = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.collection('events').where({ date })
      .field({ _id: true }).skip(offset).limit(100).get();
    const rows = page.data || [];
    rows.forEach(row => { if (row._id && row._id !== eventId) ids.push(row._id); });
    if (rows.length < 100) break;
  }
  const candidates = new Map();
  for (let i = 0; i < ids.length; i += 10) {
    const page = await db.collection('registrations').where({
      _openid: openid, eventId: db.command.in(ids.slice(i, i + 10))
    }).limit(100).get();
    (page.data || []).forEach(row => { if (row._id) candidates.set(row._id, row); });
    if ((page.data || []).length === 100) throw new Error('Same-day registration lookup exceeds limit');
  }
  return { ids, candidates: [...candidates.values()] };
}

async function switchFreeRegistration(db, options) {
  const { openid, eventId, guest, registrationData, validateTarget } = options;
  if (!openid || !guest || !guest._id) {
    return { success: false, code: 'UNAUTHORIZED', message: 'Guest profile is required' };
  }
  const regId = eventId + '_' + openid;

  // This lookup is scoped to the destination, not guest history.
  const destination = await db.collection('registrations')
    .where({ _openid: openid, eventId }).limit(1).get();
  const destinationId = ((destination.data || [])[0] || {})._id;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Re-query on each retry: a conflicting concurrent write to the guest
    // document forces a new snapshot and discovers the other same-day ticket.
    const targetRow = await db.collection('events').doc(eventId).get();
    const date = targetRow.data && targetRow.data.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return {
      success: false, code: 'EVENT_DATE_UNAVAILABLE', message: 'Event date is unavailable'
    };
    const scope = await sameDateCandidates(db, openid, eventId, date);
    const tx = await db.startTransaction();
    try {
      const cache = new Map();
      const read = async (collection, id) => {
        const key = collection + '/' + id;
        if (!cache.has(key)) {
          const result = await tx.collection(collection).doc(id).get();
          cache.set(key, result && result.data || null);
        }
        return cache.get(key);
      };
      const optionalRead = async (collection, id) => {
        try { return await read(collection, id); }
        catch (_) { return null; } // An unverifiable old row is never cancelled.
      };
      const owner = await read('guests', guest._id);
      if (!owner || owner._openid !== openid) throw policyError('UNAUTHORIZED', 'Guest profile changed');
      const target = await read('events', eventId);
      const now = Date.now();
      if (!target || target.deleting === true) throw policyError('EVENT_DELETING', 'Event is no longer available');
      if ((target.status && target.status !== 'active') || eventHasFinished(target, now)) {
        throw policyError('EVENT_OVER', 'Event has ended');
      }
      const deterministic = await read('registrations', regId);
      if (deterministic && deterministic._openid !== openid) {
        throw policyError('REGISTRATION_OWNER_CONFLICT', 'Existing destination ticket ownership needs review');
      }
      const legacy = !deterministic && destinationId ? await read('registrations', destinationId) : null;
      const current = deterministic || (legacy && legacy._openid === openid && legacy.eventId === eventId ? legacy : null);
      if (current) {
        await tx.rollback();
        return { success: true, code: 'ALREADY_REGISTERED', replacedEventIds: [], retainedEventIds: [] };
      }
      // Only destination availability applies. Old payments, missing attendance
      // times and unavailable old events are never registration refusal reasons.
      const availability = await validateTarget(target);
      if (!availability.available) {
        throw policyError(availability.reason === 'time' ? 'FREE_CLOSED_BY_TIME' : 'FREE_SOLD_OUT', 'Free entry is closed');
      }
      if (target.date !== date) throw policyError('EVENT_DATE_CHANGED', 'Event date changed; please retry');
      const outcomes = [];
      const cancellations = [];
      const confirmationRows = [];
      for (const candidate of scope.candidates) {
        const previous = await optionalRead('registrations', candidate._id);
        if (!previous || previous._openid !== openid || previous.eventId === eventId || !isFreeRegistration(previous)) continue;
        if (!scope.ids.includes(previous.eventId)) continue;
        const previousEvent = await optionalRead('events', previous.eventId);
        if (!previousEvent || previousEvent.date !== date) continue;
        let reason = retentionReason(previous, previousEvent, now);
        if (!reason && (previous.arrivedAt || previous.scannedAt) && !Number.isFinite(attendanceMs(previous, previousEvent))) {
          reason = 'unknown_arrival';
        }
        if (!reason) {
          const order = await optionalRead('orders', previous.eventId + '_' + openid);
          if (order && !['cancelled', 'canceled', 'closed', 'failed', 'refunded'].includes(order.status)) reason = 'protected_payment';
        }
        const title = previousEvent.title || previous.eventTitle || '';
        if (!reason && !title) reason = 'unavailable';
        const outcome = { registrationId: previous._id, eventId: previous.eventId,
          eventTitle: title, outcome: reason ? 'kept' : 'cancelled', reason: reason || 'switch_event' };
        outcomes.push(outcome);
        confirmationRows.push([outcome.registrationId, outcome.eventId, outcome.eventTitle,
          outcome.outcome, outcome.reason, timestampMs(previous.createdAt) || null]);
        if (!reason) cancellations.push({ previous, previousEvent, outcome });
      }
      // Never silently delete a same-day ticket for a legacy client. Clients
      // that cannot confirm keep their old registration untouched.
      const notify = cancellations.length > 0 || (options.requireReplacementConfirmation === true &&
        options.notifyRegistrationConsequences === true && outcomes.length > 0);
      if (notify) {
        const confirmation = crypto.createHash('sha256').update(JSON.stringify([
          openid, eventId, date, confirmationRows
        ])).digest('hex');
        if (options.replacementConfirmation !== confirmation) {
          await tx.rollback();
          return {
            success: true, code: 'REGISTRATION_CONFIRMATION_REQUIRED',
            replacements: cancellations.map(item => item.outcome), previousRegistrations: outcomes,
            replacementConfirmation: confirmation
          };
        }
      }
      for (const { previous } of cancellations) await tx.collection('registrations').doc(previous._id).remove();
      await tx.collection('registrations').doc(regId).set({ data: {
        ...registrationData, _openid: openid, eventId, eventTitle: target.title || '', eventDate: target.date || '',
        ticketType: 'Free Entry', status: 'confirmed', createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      await tx.collection('guests').doc(guest._id).update({ data: {
        activeFreeRegistrationId: regId, activeFreeEventId: eventId, activeFreeEventTitle: target.title || '',
        freeRegistrationUpdatedAt: db.serverDate()
      } });
      for (const { previous, previousEvent } of cancellations) {
        await tx.collection('events').doc(previous.eventId).update({ data: {
          guestCount: Math.max(0, (Number(previousEvent.guestCount) || 0) - 1),
          guestCountSyncedAt: db.serverDate(), registrationsChangedAt: db.serverDate(),
          freeRegistrationRemovalVersion: (Number(previousEvent.freeRegistrationRemovalVersion) || 0) + 1
        } });
      }
      await tx.collection('events').doc(eventId).update({ data: {
        guestCount: (Number(target.guestCount) || 0) + 1,
        guestCountSyncedAt: db.serverDate(), registrationsChangedAt: db.serverDate()
      } });
      const actorName = String(registrationData.guestName || guest.nickName || guest.name || '').slice(0, 160);
      const joinedId = crypto.createHash('sha256').update('guest-joined:' + regId).digest('hex');
      await tx.collection('counter_session_history').doc(joinedId).set({ data: {
        type: cancellations.length ? 'GUEST_SWITCHED' : 'GUEST_REGISTERED', at: db.serverDate(),
        venueId: target.venueId || '', venueName: target.venueName || '', eventId,
        eventTitle: target.title || '', eventDate: target.date || '', startTime: target.startTime || '', endTime: target.endTime || '',
        actorId: guest._id, actorName, actorRole: 'guest', targetId: regId, targetName: actorName,
        sessionId: '', result: 'success', details: cancellations.length ? {
          previousEventId: cancellations[0].previous.eventId, previousEventTitle: cancellations[0].outcome.eventTitle,
          previousEventIds: cancellations.map(item => item.previous.eventId)
        } : {}
      } });
      for (const { previous, previousEvent, outcome } of cancellations) {
        const cancelledId = crypto.createHash('sha256').update('guest-cancelled:' + previous._id + ':' + regId).digest('hex');
        await tx.collection('counter_session_history').doc(cancelledId).set({ data: {
          type: 'GUEST_REGISTRATION_CANCELLED', at: db.serverDate(),
          venueId: previousEvent.venueId || '', venueName: previousEvent.venueName || '',
          eventId: previous.eventId, eventTitle: outcome.eventTitle || '', eventDate: previous.eventDate || '',
          actorId: guest._id, actorName, actorRole: 'guest', targetId: previous._id, targetName: actorName,
          sessionId: '', result: 'success', reason: 'switch_event', details: { newEventId: eventId, newEventTitle: target.title || '' }
        } });
      }
      await tx.commit();
      return {
        success: true, replacedEventIds: cancellations.map(item => item.previous.eventId),
        retainedEventIds: outcomes.filter(item => item.outcome === 'kept').map(item => item.eventId)
      };
    } catch (error) {
      await tx.rollback().catch(() => {});
      if (error.policyCode) return {
        success: /^(EVENT_|FREE_)/.test(error.policyCode), code: error.policyCode, message: error.message
      };
      const text = String(error && (error.errMsg || error.message || error.code) || error);
      if (attempt < 3 && /conflict|transaction.*abort|transaction.*retry|lock.*(fail|timeout)/i.test(text)) continue;
      throw error;
    }
  }
  throw new Error('Registration transaction could not complete');
}

module.exports = { switchFreeRegistration };
