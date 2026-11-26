'use strict';

const crypto = require('crypto');
const { isFreeRegistration, eventHasFinished, attendanceMs, retentionReason, timestampMs } = require('./freeRegistrationPolicy');

function policyError(code, message) {
  const error = new Error(message);
  error.policyCode = code;
  return error;
}

// Bootstrap ONE recent entry only for profiles without a current-booking
// cursor. Yesterday covers overnight Shanghai events; never scan all history.
async function currentEntryFallback(db, openid, eventId, guest, since) {
  if (guest.activeFreeRegistrationId) return null;
  try {
    const result = await db.collection('registrations').where({
      _openid: openid, eventId: db.command.neq(eventId), ticketType: 'Free Entry',
      paid: db.command.neq(true), eventDate: db.command.gte(since)
    }).orderBy('createdAt', 'desc').limit(1).get();
    return (result.data || [])[0] || null;
  } catch (_) {
    return null; // Preserve unavailable old data; do not prohibit a new booking.
  }
}

async function switchFreeRegistration(db, options) {
  const { openid, eventId, guest, registrationData, validateTarget } = options;
  if (!openid || !guest || !guest._id) {
    return { success: false, code: 'UNAUTHORIZED', message: 'Guest profile is required' };
  }
  const regId = eventId + '_' + openid;
  const since = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
  // This lookup is scoped to the destination, not guest history.
  const destination = await db.collection('registrations')
    .where({ _openid: openid, eventId }).limit(1).get();
  const destinationId = ((destination.data || [])[0] || {})._id;
  const fallback = await currentEntryFallback(db, openid, eventId, guest, since);
  let preservePrevious = false;
  let previousSnapshot = fallback;

  for (let attempt = 0; attempt < 4; attempt++) {
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
        catch (_) {
          const error = new Error('Previous entry lookup unavailable');
          error.previousLookupUnavailable = true;
          throw error;
        }
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
      const previousId = owner.activeFreeRegistrationId || (fallback && fallback._id);
      let previous = null;
      let previousEvent = null;
      let outcome = null;
      let retainReason = '';
      if (previousId && previousId !== regId && previousId !== destinationId) {
        if (preservePrevious) {
          const snapshot = previousSnapshot && previousSnapshot._id === previousId ? previousSnapshot : null;
          outcome = {
            registrationId: previousId, eventId: snapshot && snapshot.eventId || owner.activeFreeEventId || '',
            eventTitle: snapshot && snapshot.eventTitle || owner.activeFreeEventTitle || '',
            outcome: 'kept', reason: 'unavailable'
          };
        } else {
          previous = await optionalRead('registrations', previousId);
          if (previous && previous._openid === openid && previous.eventId !== eventId && isFreeRegistration(previous)) {
            previousSnapshot = previous;
            // A stale cursor does not justify looking up historical events.
            const oldSnapshot = /^\d{4}-\d{2}-\d{2}$/.test(previous.eventDate || '') && previous.eventDate < since;
            if (!oldSnapshot) {
              previousEvent = previous.eventId ? await optionalRead('events', previous.eventId) : null;
              retainReason = !previousEvent ? 'unavailable' : retentionReason(previous, previousEvent, now);
              if (!retainReason && (previous.arrivedAt || previous.scannedAt) && !Number.isFinite(attendanceMs(previous, previousEvent))) {
                retainReason = 'unknown_arrival';
              }
              if (!retainReason) {
                const order = await optionalRead('orders', previous.eventId + '_' + openid);
                if (order && !['cancelled', 'canceled', 'closed', 'failed', 'refunded'].includes(order.status)) {
                  retainReason = 'protected_payment';
                }
              }
              const previousTitle = previousEvent && previousEvent.title || previous.eventTitle || '';
              if (!retainReason && !previousTitle) retainReason = 'unavailable';
              outcome = {
                registrationId: previous._id, eventId: previous.eventId || '',
                eventTitle: previousTitle,
                outcome: retainReason ? 'kept' : 'cancelled', reason: retainReason || 'switch_event'
              };
            }
          }
        }
      }
      const cancelling = outcome && outcome.outcome === 'cancelled';
      const notify = options.requireReplacementConfirmation === true && outcome &&
        (cancelling || options.notifyRegistrationConsequences === true);
      if (notify) {
        const confirmation = crypto.createHash('sha256').update(JSON.stringify([
          openid, eventId, outcome.registrationId, outcome.eventId, outcome.eventTitle,
          outcome.outcome, outcome.reason, previous ? timestampMs(previous.createdAt) || null : null
        ])).digest('hex');
        if (options.replacementConfirmation !== confirmation) {
          await tx.rollback();
          return {
            success: true, code: 'REGISTRATION_CONFIRMATION_REQUIRED',
            replacements: cancelling ? [outcome] : [], previousRegistrations: [outcome],
            replacementConfirmation: confirmation
          };
        }
      }
      // Apply only this current-entry consequence. No other history is read,
      // removed or revalidated, and no old-record problem prohibits the booking.
      if (cancelling) await tx.collection('registrations').doc(previous._id).remove();
      await tx.collection('registrations').doc(regId).set({ data: {
        ...registrationData, _openid: openid, eventId, eventTitle: target.title || '', eventDate: target.date || '',
        ticketType: 'Free Entry', status: 'confirmed', createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      await tx.collection('guests').doc(guest._id).update({ data: {
        activeFreeRegistrationId: regId, activeFreeEventId: eventId, activeFreeEventTitle: target.title || '',
        freeRegistrationUpdatedAt: db.serverDate()
      } });
      if (cancelling) {
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
        type: cancelling ? 'GUEST_SWITCHED' : 'GUEST_REGISTERED', at: db.serverDate(),
        venueId: target.venueId || '', venueName: target.venueName || '', eventId,
        eventTitle: target.title || '', eventDate: target.date || '', startTime: target.startTime || '', endTime: target.endTime || '',
        actorId: guest._id, actorName, actorRole: 'guest', targetId: regId, targetName: actorName,
        sessionId: '', result: 'success', details: cancelling ? {
          previousEventId: previous.eventId, previousEventTitle: outcome.eventTitle
        } : {}
      } });
      if (cancelling) {
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
        success: true, replacedEventIds: cancelling ? [previous.eventId] : [],
        retainedEventIds: outcome && !cancelling && outcome.eventId ? [outcome.eventId] : []
      };
    } catch (error) {
      await tx.rollback().catch(() => {});
      if (error.previousLookupUnavailable && attempt < 3) {
        // A fresh transaction can still register the valid destination while
        // preserving the previous entry whose data could not be verified.
        preservePrevious = true;
        continue;
      }
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
