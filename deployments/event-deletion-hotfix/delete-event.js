'use strict';

// This function is embedded into the downloaded production entry point by
// apply-hotfix.js. Keep every helper inside it: no dependencies or env changes.
async function deleteEventSafely(db, targetId, context) {
  const startedAt = Date.now();
  const budgetMs = 40000;
  const batchSize = 100;
  const maxBatches = 50;
  const financialFields = [
    'paid', 'paidAmountFen', 'amountFen', 'orderId', 'transactionId',
    'paymentStatus', 'status', 'ticketType', 'refunded'
  ];
  const projection = { _id: true, eventId: true };
  financialFields.forEach(key => { projection[key] = true; });
  const operationId = require('crypto').randomBytes(12).toString('hex');
  let ownsGate = false;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function budget() {
    if (Date.now() - startedAt >= budgetMs) {
      fail('EVENT_DELETE_RETRY', 'Deletion reached its safe time budget. Please retry.');
    }
  }

  function financial(row) {
    const state = String(row.paymentStatus || '').toLowerCase();
    const status = String(row.status || '').toLowerCase();
    return row.paid === true || row.refunded === true ||
      Number(row.paidAmountFen) > 0 || Number(row.amountFen) > 0 ||
      !!row.orderId || !!row.transactionId ||
      ['paid', 'settled', 'refunded', 'partially_refunded'].includes(state) ||
      ['paid', 'settled', 'refunded', 'partially_refunded'].includes(status) ||
      String(row.ticketType || '').toLowerCase() === 'paid';
  }

  async function ensureNoOrders() {
    budget();
    const result = await db.collection('orders').where({ eventId: targetId }).count();
    if (!result || typeof result.total !== 'number') {
      fail('EVENT_DELETE_UNVERIFIED', 'Could not verify linked payment orders. Nothing will be deleted.');
    }
    if (result.total > 0) {
      fail('EVENT_HAS_PAYMENT_ORDERS',
        'This event has payment orders. Resolve purchases/refunds before permanent deletion. Orders and payments were not changed.');
    }
  }

  async function ensureNoPaidTickets() {
    let offset = 0;
    let pages = 0;
    while (true) {
      budget();
      const result = await db.collection('registrations').where({ eventId: targetId })
        .orderBy('_id', 'asc').skip(offset).field(projection).limit(batchSize).get();
      const rows = result.data;
      if (!Array.isArray(rows)) fail('EVENT_DELETE_UNVERIFIED', 'Could not verify event tickets.');
      if (!rows.length) return;
      if (pages >= maxBatches) fail('EVENT_DELETE_LIMIT', 'Too many tickets for a safe single deletion. No tickets have been removed.');
      if (rows.some(financial)) {
        fail('EVENT_HAS_PAID_TICKETS',
          'This event has paid or financial ticket records, including TEST tickets marked paid. Resolve them before permanent deletion. Purchased tickets were not deleted.');
      }
      offset += rows.length;
      pages++;
    }
  }

  async function drainFreeRegistrations() {
    let removed = 0;
    let batches = 0;
    let emptyRounds = 0;
    while (emptyRounds < 5) {
      budget();
      await ensureNoOrders();
      const result = await db.collection('registrations').where({ eventId: targetId })
        .field(projection).limit(batchSize).get();
      const rows = result.data;
      if (!Array.isArray(rows)) fail('EVENT_DELETE_UNVERIFIED', 'Could not read the registration deletion batch.');
      if (!rows.length) {
        emptyRounds++;
        if (emptyRounds < 5) await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (batches >= maxBatches) fail('EVENT_DELETE_RETRY', 'Registration deletion reached its safe batch limit. Please retry.');
      if (rows.some(financial)) fail('EVENT_HAS_PAID_TICKETS', 'A financial ticket appeared during deletion. It was preserved; deletion stopped.');
      emptyRounds = 0;
      for (let offset = 0; offset < rows.length; offset += 10) {
        budget();
        const counts = await Promise.all(rows.slice(offset, offset + 10).map(async row => {
          // Compare all financial fields atomically. A concurrent free-to-paid
          // upgrade must make the deletion selector stop matching this row.
          const selector = { _id: row._id, eventId: targetId };
          financialFields.forEach(key => {
            selector[key] = Object.prototype.hasOwnProperty.call(row, key)
              ? row[key] : db.command.exists(false);
          });
          const deleted = await db.collection('registrations').where(selector).remove();
          if (deleted.stats && deleted.stats.removed === 1) return 1;
          const remaining = await db.collection('registrations').where({ _id: row._id }).count();
          if (!remaining || remaining.total !== 0) {
            fail('EVENT_DELETE_RETRY', 'A ticket changed or could not be removed. It was preserved; please retry.');
          }
          return 0;
        }));
        removed += counts.reduce((total, count) => total + count, 0);
      }
      batches++;
    }
    return removed;
  }

  try {
    if (typeof targetId !== 'string' || !targetId) fail('INVALID_EVENT_ID', 'No valid event ID provided.');
    // Financial preflight happens BEFORE closing or deleting anything. Fail
    // closed on unavailable collections/queries; never guess a zero count.
    await ensureNoOrders();
    await ensureNoPaidTickets();
    const existing = await db.collection('events').where({ _id: targetId }).limit(1).get();
    if (!Array.isArray(existing.data)) fail('EVENT_DELETE_UNVERIFIED', 'Could not read the event.');
    const eventDoc = existing.data[0];
    if (eventDoc) {
      // Existing createOrder rejects isClosed, but an earlier request can
      // still finish for up to its runtime. Paid inventory requires a stable
      // closed window before removing the event; do not change payments.
      const toMillis = value => {
        if (value && typeof value === 'object' && '$date' in value) value = value.$date;
        const parsed = value instanceof Date ? value.getTime()
          : typeof value === 'number' ? value : Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const closedSince = Math.max(toMillis(eventDoc.closedAt), toMillis(eventDoc.updatedAt),
        Number(eventDoc.deletionClosedAtMs) || 0);
      const hasPaidInventory = eventDoc.isPaid === true || eventDoc.hasPaidPackages === true ||
        [].concat(eventDoc.tickets || [], eventDoc.paidPackages || []).some(ticket => ticket && Number(ticket.price) > 0);
      const stableClosure = eventDoc.isClosed === true && closedSince > 0 && Date.now() - closedSince >= 65000;
      const selector = { _id: targetId };
      if (eventDoc.deleting === true) {
        if (Number(eventDoc.deletionStartedAtMs) > Date.now() - 65000) {
          fail('EVENT_DELETE_IN_PROGRESS', 'Another deletion is in progress. Please retry in a minute.');
        }
        selector.deleting = true;
        selector.deletionStartedAtMs = Object.prototype.hasOwnProperty.call(eventDoc, 'deletionStartedAtMs')
          ? eventDoc.deletionStartedAtMs : db.command.exists(false);
      } else {
        selector.deleting = db.command.neq(true);
      }
      const gated = await db.collection('events').where(selector).update({ data: {
        deleting: true, isClosed: true, deletionOperationId: operationId,
        // Without closedAt, the existing archival sweep treats a fresh
        // closure as already due. Preserve a real closure timestamp.
        closedAt: eventDoc.isClosed === true && eventDoc.closedAt ? eventDoc.closedAt : db.serverDate(),
        deletionClosedAtMs: eventDoc.isClosed === true && closedSince > 0 ? closedSince : Date.now(),
        deletionStartedAtMs: Date.now(), updatedAt: db.serverDate()
      } });
      if (!gated.stats || gated.stats.updated !== 1) {
        fail('EVENT_DELETE_RETRY', 'The event changed before deletion. Please retry.');
      }
      ownsGate = true;
      if (hasPaidInventory && !stableClosure) {
        fail('EVENT_DELETE_WAIT', 'Ticket sales are now closed. Retry deletion after 65 seconds so in-flight payment requests can finish. No tickets were removed.');
      }
    }
    await ensureNoOrders();
    await ensureNoPaidTickets();
    const firstRemoved = await drainFreeRegistrations();
    await ensureNoOrders();
    await ensureNoPaidTickets();
    budget();
    const eventSelector = ownsGate
      ? { _id: targetId, deletionOperationId: operationId }
      : { _id: targetId };
    await db.collection('events').where(eventSelector).remove();
    const finalRemoved = await drainFreeRegistrations();
    const [events, registrations] = await Promise.all([
      db.collection('events').where({ _id: targetId }).count(),
      db.collection('registrations').where({ eventId: targetId }).count()
    ]);
    if (!events || events.total !== 0 || !registrations || registrations.total !== 0) {
      fail('EVENT_DELETE_UNVERIFIED', 'Event deletion is not complete. Please retry; success was not confirmed.');
    }
    return { success: true, removedEvent: true,
      removedRegistrations: firstRemoved + finalRemoved,
      remainingEvents: 0, remainingRegistrations: 0 };
  } catch (error) {
    // Leave ordinary closure in place, but release OUR deleting marker so a
    // paid order can still recover its ticket through the existing healer.
    if (ownsGate) {
      await db.collection('events').where({ _id: targetId, deletionOperationId: operationId })
        .update({ data: { deleting: false, deletionOperationId: '', deletionStartedAtMs: 0 } })
        .catch(() => {});
    }
    const code = error.code || 'EVENT_DELETE_FAILED';
    const message = code + ': ' + String(error.message || 'Event deletion failed.');
    const requestId = context && (context.request_id || context.requestId);
    console.error('[event-delete]', { eventId: targetId, code, message, requestId });
    return { success: false, code, error: message, message, ...(requestId ? { requestId } : {}) };
  }
}

module.exports = deleteEventSafely;
