'use strict';

const { isFreeRegistration, eventHasFinished, attendanceMs, retentionReason } = require('./freeRegistrationPolicy');

function policyError(code, message) {
  const err = new Error(message);
  err.policyCode = code;
  return err;
}

async function readOwnedRegistrations(db, openid) {
  const rows = [];
  const pageSize = 100;
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const res = await db.collection('registrations').where({ _openid: openid })
      .orderBy('_id', 'asc').skip(offset).limit(pageSize).get();
    rows.push(...(res.data || []));
    if ((res.data || []).length < pageSize) return rows;
  }
  throw policyError('REGISTRATION_HISTORY_TOO_LARGE', 'Registration history could not be read completely');
}

// The caller passes a database configured with throwOnNotFound:false. Every
// old-registration removal, new registration, owner cursor and event count is
// committed together. Never delete the first ticket before the second is valid.
async function switchFreeRegistration(db, options) {
  const { openid, eventId, guest, registrationData, validateTarget } = options;
  if (!openid || !guest || !guest._id) {
    return { success: false, code: 'UNAUTHORIZED', message: 'Guest profile is required' };
  }
  const regId = eventId + '_' + openid;
  const owned = await readOwnedRegistrations(db, openid);
  const candidateIds = owned.filter(isFreeRegistration).map(r => r._id);
  // Same-event paid/legacy records must also prevent a duplicate free ticket.
  owned.filter(r => r.eventId === eventId).forEach(r => candidateIds.push(r._id));

  for (let attempt = 0; attempt < 3; attempt++) {
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
      const owner = await read('guests', guest._id);
      if (!owner || owner._openid !== openid) throw policyError('UNAUTHORIZED', 'Guest profile changed');
      const target = await read('events', eventId);
      const now = Date.now();
      if (!target || target.deleting === true) throw policyError('EVENT_DELETING', 'Event is no longer available');
      if ((target.status && target.status !== 'active') || eventHasFinished(target, now)) {
        throw policyError('EVENT_OVER', 'Event has ended');
      }
      const ids = [...new Set(candidateIds.concat(owner.activeFreeRegistrationId || [], regId))];
      if (ids.length > 200) throw policyError('REGISTRATION_HISTORY_TOO_LARGE', 'Registration history needs administrative review');
      const rows = [];
      for (const id of ids) {
        const row = await read('registrations', id);
        if (row && id === regId && row._openid !== openid) {
          throw policyError('REGISTRATION_OWNER_CONFLICT', 'Existing ticket ownership needs administrative review');
        }
        if (row && row._openid === openid) rows.push(row);
      }
      const current = rows.find(r => r.eventId === eventId);
      if (current && !isFreeRegistration(current)) {
        await tx.rollback();
        return { success: true, code: 'ALREADY_REGISTERED', replacedEventIds: [] };
      }
      if (!current) {
        const targetOrder = await read('orders', regId);
        if (targetOrder && !['cancelled', 'canceled', 'closed', 'failed', 'refunded'].includes(targetOrder.status)) {
          throw policyError('REGISTRATION_PAYMENT_PENDING', 'Finish or cancel the existing payment first');
        }
        // All existing availability checks still run before any write.
        const availability = await validateTarget(target);
        if (!availability.available) {
          throw policyError(availability.reason === 'time' ? 'FREE_CLOSED_BY_TIME' : 'FREE_SOLD_OUT', 'Free entry is closed');
        }
      }
      const removals = [];
      const retained = [];
      const eventDocs = new Map([[eventId, target]]);
      for (const row of rows) {
        if (row.eventId === eventId || !isFreeRegistration(row)) continue;
        const previous = await read('events', row.eventId);
        if (!previous) throw policyError('REGISTRATION_EVENT_UNAVAILABLE', 'Previous event could not be resolved');
        eventDocs.set(row.eventId, previous);
        const reason = retentionReason(row, previous, now);
        if (reason) {
          if (reason === 'three_hours') retained.push(row);
          continue;
        }
        if ((row.arrivedAt || row.scannedAt) && !Number.isFinite(attendanceMs(row, previous))) {
          throw policyError('REGISTRATION_TIME_UNAVAILABLE', 'Previous arrival time needs administrative review');
        }
        const order = await read('orders', row.eventId + '_' + openid);
        if (order && !['cancelled', 'canceled', 'closed', 'failed', 'refunded'].includes(order.status)) {
          throw policyError('REGISTRATION_PAYMENT_PENDING', 'A previous ticket payment must be resolved first');
        }
        removals.push(row);
      }
      // Every read and policy gate precedes the first write.
      const countChanges = new Map();
      for (const row of removals) {
        await tx.collection('registrations').doc(row._id).remove();
        countChanges.set(row.eventId, (countChanges.get(row.eventId) || 0) - 1);
      }
      for (const row of retained) {
        await tx.collection('registrations').doc(row._id).update({ data: {
          freeVisitRetainedAt: db.serverDate(), freeVisitRetentionReason: 'three_hours', updatedAt: db.serverDate()
        } });
      }
      if (!current) {
        // The server-derived owner and canonical free type cannot be overridden.
        await tx.collection('registrations').doc(regId).set({ data: {
          ...registrationData, _openid: openid, eventId,
          eventTitle: target.title || '', eventDate: target.date || '',
          ticketType: 'Free Entry', status: 'confirmed', createdAt: db.serverDate(), updatedAt: db.serverDate()
        } });
        countChanges.set(eventId, (countChanges.get(eventId) || 0) + 1);
      }
      // Touching the shared profile serializes even two requests aimed at
      // different events. A retry reads the latest cursor inside its transaction.
      await tx.collection('guests').doc(guest._id).update({ data: {
        activeFreeRegistrationId: current ? current._id : regId,
        activeFreeEventId: eventId, freeRegistrationUpdatedAt: db.serverDate()
      } });
      for (const [id, delta] of countChanges) {
        const ev = eventDocs.get(id);
        await tx.collection('events').doc(id).update({ data: {
          guestCount: Math.max(0, (Number(ev.guestCount) || 0) + delta),
          guestCountSyncedAt: db.serverDate(), registrationsChangedAt: db.serverDate(),
          ...(delta < 0 ? { freeRegistrationRemovalVersion: (Number(ev.freeRegistrationRemovalVersion) || 0) + 1 } : {})
        } });
      }
      await tx.commit();
      return {
        success: true,
        ...(current ? { code: 'ALREADY_REGISTERED' } : {}),
        replacedEventIds: [...new Set(removals.map(r => r.eventId))],
        retainedEventIds: [...new Set(retained.map(r => r.eventId))]
      };
    } catch (err) {
      await tx.rollback().catch(() => {});
      if (err.policyCode) return {
        success: /^(EVENT_|FREE_)/.test(err.policyCode), code: err.policyCode, message: err.message
      };
      const text = String(err && (err.errMsg || err.message || err.code) || err);
      if (attempt < 2 && /conflict|transaction.*abort|transaction.*retry|lock.*(fail|timeout)/i.test(text)) continue;
      throw err;
    }
  }
  throw new Error('Free registration transaction could not complete');
}

module.exports = { switchFreeRegistration };
