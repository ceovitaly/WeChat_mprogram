const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { createToken: createCheckinToken } = require('./checkinTokens');

// ─── Door check-in tokens ───────────────────────────────────────────────────
// Stateless anti-fraud tokens for the counter-screen QR (guest scans → scan is
// recorded on their registration → counter still taps the check-in). The token
// is `eventId.exp.sig` where sig = HMAC(eventId.exp, SECRET) truncated. No
// storage: rotation every 20s costs zero DB writes, expiry kills replays, and
// the signature stops anyone minting tokens for an event they're not working.
// CHECKIN_SECRET is injected into both cloud functions as an environment
// variable. It must be the same value in manageApplications and clientAuth.
// One code per counter tap (manual refresh); 20s display window, per spec —
// expiry kills replays/screenshots.
const CHECKIN_TTL_SEC = 20;
const MAX_DELETE_BATCHES = 50;
const DELETE_EMPTY_ROUNDS = 5;

async function drainEventRegistrations(eventId) {
  let removed = 0;
  let batchCount = 0;
  let emptyRounds = 0;
  while (true) {
    const regsRes = await db.collection('registrations')
      .where({ eventId })
      .field({ _id: true })
      .limit(1000)
      .get();
    const registrations = regsRes.data || [];
    if (registrations.length > 0 && batchCount >= MAX_DELETE_BATCHES) {
      return { removed, settled: false };
    }
    if (registrations.length === 0) {
      emptyRounds++;
      if (emptyRounds >= DELETE_EMPTY_ROUNDS) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    emptyRounds = 0;
    await Promise.all(registrations.map(r =>
      db.collection('registrations').doc(r._id).remove()
    ));
    removed += registrations.length;
    batchCount++;
  }
  return { removed, settled: emptyRounds >= DELETE_EMPTY_ROUNDS };
}


async function getCallerStaff(db) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return null;
  // One openid can sit on SEVERAL staff docs: an admin who logs into a
  // counter's workspace from their own WeChat (support/testing) leaves their
  // openid on that counter's doc too. loginStaff clears the stale copy on the
  // NEXT login, but until then a bare limit(1) could resolve the caller as
  // the counter — silently demoting the admin and locking every admin-only
  // action ("Forbidden" lists on Team pages). Fetch a few matches and prefer
  // the admin role; the collision then costs nothing.
  const res = await db.collection('staff').where({ lastOpenid: openid }).limit(5).get();
  const rows = res.data || [];
  if (rows.length === 0) return null;
  return rows.find(s => s.role === 'admin') || rows[0];
}

// ─── Registration read model ────────────────────────────────────────────────
// Whitelist of registration fields served to list UIs (event-guests, counter
// work, promoter views). An explicit whitelist — not an "everything except the
// avatar" exclusion — caps row size permanently: fields added to registrations
// later can never silently push a 1000-row page back over the ~1MB
// callFunction reply cap.
const REG_FIELDS = {
  _id: true,
  _openid: true,
  guestName: true,
  guestPhone: true,
  promoCode: true,
  promoterId: true,
  promoterName: true,
  ticketType: true,
  ticketId: true,
  status: true,
  paid: true,
  paidAmountFen: true,
  eventTitle: true,
  eventDate: true,
  arrivedAt: true,
  checkedInAt: true,
  scannedAt: true
};

// Phone self-heal (invisible badge key — see utils/phoneMatch on the client).
// Rows written by the guest app before the guestPhone snapshot existed carry
// no phone; look up THOSE rows only in the guest profiles, and write the phone
// back onto the registration so this join shrinks to zero as legacy rows are
// healed — no manual migration run. Best-effort and isolated: on failure the
// list ships without phones (STAFF/PROMOTER badges degrade) instead of failing.
async function healGuestPhones(db, regs) {
  const legacy = regs.filter(r => !r.guestPhone && r._openid);
  if (legacy.length === 0) return {};
  const byOpenid = {};
  try {
    const openids = [...new Set(legacy.map(r => r._openid))];
    const BATCH = 500;
    const batches = [];
    for (let i = 0; i < openids.length; i += BATCH) batches.push(openids.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(batch =>
      db.collection('guests')
        .where({ _openid: db.command.in(batch) })
        .field({ _openid: true, phone: true })
        .limit(1000)
        .get()
    ));
    results.forEach(res => (res.data || []).forEach(g => { if (g.phone) byOpenid[g._openid] = g.phone; }));
    await Promise.all(legacy.map(r => byOpenid[r._openid]
      ? db.collection('registrations').doc(r._id).update({ data: { guestPhone: byOpenid[r._openid] } }).catch(() => {})
      : null));
  } catch (e) { /* keep whatever was healed */ }
  return byOpenid;
}

// Guest counts for the Events tab / past events, from the STORED counter on
// the event doc. Exact writers (payments inc on new registrations, the count
// sync inside getRegistrations) stamp guestCountSyncedAt; a stored count that
// is missing or older than COUNT_STALE_MS is recounted once and written back.
// Free registrations are still written client-side by the published guest app
// (no server hook yet), so the stale window bounds how far the stored counter
// can lag until that write moves server-side — while keeping the tab at one
// cheap read per event in the common case instead of a count() fan-out.
const COUNT_STALE_MS = 5 * 60 * 1000;
const dateFieldToMs = (v) => {
  if (!v) return 0;
  const raw = (typeof v === 'object' && v.$date !== undefined) ? v.$date : v;
  const t = new Date(raw).getTime();
  return isNaN(t) ? 0 : t;
};

async function attachGuestCounts(db, events, includeArrivedCounts = false) {
  return Promise.all(events.map(async ev => {
    if (includeArrivedCounts) {
      let arrivedCount = null;
      try {
        // Count every valid arrival, including manual NO SCAN marks and paid
        // guests. Database count() has no client page-size truncation.
        const count = await db.collection('registrations').where(db.command.and([
          { eventId: ev._id },
          { arrivedAt: db.command.exists(true) },
          { arrivedAt: db.command.nin([null, '', false, 0]) }
        ])).count();
        arrivedCount = Number(count.total) || 0;
      } catch (_) { /* unknown is not zero; the client displays a dash */ }
      ev = Object.assign({}, ev, { arrivedCount });
    }
    const hasStored = typeof ev.guestCount === 'number';
    const fresh = hasStored && (Date.now() - dateFieldToMs(ev.guestCountSyncedAt)) < COUNT_STALE_MS;
    if (fresh) return Object.assign({}, ev, { guestCount: ev.guestCount });
    try {
      const cnt = await db.collection('registrations').where({ eventId: ev._id }).count();
      const n = cnt.total || 0;
      await db.collection('events').doc(ev._id).update({
        data: { guestCount: n, guestCountSyncedAt: db.serverDate() }
      }).catch(() => {});
      return Object.assign({}, ev, { guestCount: n });
    } catch (e) {
      return Object.assign({}, ev, { guestCount: hasStored ? ev.guestCount : 0 });
    }
  }));
}

// ─── Closed-event image purge ──────────────────────────────────────────────
// Policy: an event's photos are only needed while it is live (feed cards,
// event page). The moment it flips to closed/past they are dead weight in
// cloud storage, so every close path also deletes the files AND blanks the
// doc fields — clients then stop resolving (and caching) URLs that no longer
// exist. Never throws: closing must not fail because of cleanup; anything
// left behind is caught by the idempotent cleanupClosedEventImages action.
const IMAGE_DOC_FIELDS = ['coverImage', 'promoImage', 'images', 'promoImages', 'promoMaterials'];

function collectEventFileIds(eventDoc) {
  const ids = [];
  IMAGE_DOC_FIELDS.forEach(f => {
    const v = eventDoc && eventDoc[f];
    if (typeof v === 'string' && v.indexOf('cloud://') === 0) ids.push(v);
    else if (Array.isArray(v)) v.forEach(u => {
      if (typeof u === 'string' && u.indexOf('cloud://') === 0) ids.push(u);
    });
  });
  return ids;
}

async function purgeEventImages(db, eventDoc) {
  if (!eventDoc || !eventDoc._id) return 0;
  try {
    const fileIds = collectEventFileIds(eventDoc);
    const clear = {};
    IMAGE_DOC_FIELDS.forEach(f => {
      const v = eventDoc[f];
      const has = typeof v === 'string' ? !!v : (Array.isArray(v) && v.length > 0);
      if (has) clear[f] = Array.isArray(v) ? [] : '';
    });
    if (fileIds.length > 0) {
      await cloud.deleteFile({ fileList: fileIds });
    }
    if (Object.keys(clear).length > 0) {
      await db.collection('events').doc(eventDoc._id).update({ data: clear });
    }
    return fileIds.length;
  } catch (e) {
    return 0;
  }
}

// ─── Post-event reports ────────────────────────────────────────────────────
// Two report kinds are frozen the moment an event closes (admin button or
// lazy auto-close), replicating what the admin UI builds today:
//   listReport    — the guest list as the page shows it: header (title, club,
//                   arrived / waiting / total) + rows Name / Promoter /
//                   Arrival, in the page's section order;
//   promoterReport— an exact server-side copy of the Export button's rollup
//                   (per-person invited counts by section, presence stars,
//                   roster of present internals) — do not reshape it.
// Stored as ONE doc per event in `reports` (deterministic id, replaced on
// rebuild — closing again just refreshes it). Failures never block closing.
async function ensureReportsCollection(db) {
  try { await db.createCollection('reports'); } catch (e) { /* already exists */ }
}

// Same normalization as the admin app's utils/phoneMatch.js: digits only,
// collapsed to the last 11 so +86 prefixes match plain local numbers.
function normalizePhoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 11 ? digits.slice(-11) : digits;
}

const regTimeMs = (r) => {
  const t = dateFieldToMs(r && r.checkedInAt);
  return t || NaN;
};

// Arrival-order comparator (server twin of the clients' compareArrival):
// checkedInAt is primary, the bare "HH:MM" arrivedAt string is the legacy
// fallback when either side lacks the timestamp.
function cmpArrivalServer(a, b) {
  const ta = regTimeMs(a);
  const tb = regTimeMs(b);
  if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
  const sa = (a && a.arrivedAt) || '';
  const sb = (b && b.arrivedAt) || '';
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

async function buildEventReports(db, eventDoc) {
  const eventId = eventDoc && eventDoc._id;
  if (!eventId) return { ok: false };
  try {
    await ensureReportsCollection(db);

    // Every registration of the event, whitelisted, phones healed (legacy
    // rows) — the same read model the admin list page renders from.
    const regs = [];
    for (let offset = 0; offset < 50000; offset += 1000) {
      const res = await db.collection('registrations')
        .where({ eventId })
        .orderBy('promoterName', 'asc')
        .skip(offset)
        .limit(1000)
        .field(REG_FIELDS)
        .get();
      const page = res.data || [];
      regs.push(...page);
      if (page.length < 1000) break;
    }
    const healed = await healGuestPhones(db, regs);
    regs.forEach(r => { r.phone = r.guestPhone || healed[r._openid] || ''; });

    // Rosters for the presence/badge logic (inputs mirroring exportCSV).
    const [staffRes, promotersRes] = await Promise.all([
      db.collection('staff')
        .field({ _id: true, name: true, role: true, phone: true, workedEventIds: true })
        .limit(1000)
        .get(),
      db.collection('promoters')
        .field({ _id: true, name: true, phone: true, attendedEventIds: true })
        .limit(1000)
        .get()
    ]);
    const staffList = staffRes.data || [];
    const promoters = promotersRes.data || [];
    const dutyStaff = staffList.filter(s => (s.workedEventIds || []).indexOf(eventId) !== -1);

    // Arrival order + capacity groups — the same math the admin page runs.
    const p = Number(eventDoc.partyCapacity) || 0;
    const ap = Number(eventDoc.afterPartyCapacity) || 0;
    const lap = Number(eventDoc.lateAfterPartyCapacity) || 0;
    const arrived = regs.filter(r => r.arrivedAt).sort(cmpArrivalServer).map((g, i) => {
      const num = i + 1;
      let group = '';
      if (p > 0 && num <= p) group = 'P';
      else if (ap > 0 && num <= p + ap) group = 'AP';
      else if (lap > 0 && num <= p + ap + lap) group = 'LAP';
      return { g, num, group };
    });
    const pending = regs.filter(r => !r.arrivedAt);

    // ── Report 1: the list as the page shows it ──
    // Paid guests carry a [PAID] suffix on their name — visible in the
    // downloaded file with no client-side changes needed.
    const sectionLabels = { P: 'Party', AP: 'After Party', LAP: 'Late After Party', '': 'Extra' };
    const nameOf = (r) => (r.guestName || '') + (r.paid ? ' [PAID]' : '');
    const listRows = [];
    ['P', 'AP', 'LAP', ''].forEach(tag => {
      arrived.filter(a => a.group === tag).forEach(a => {
        listRows.push({
          section: sectionLabels[tag],
          position: a.num,
          name: nameOf(a.g),
          promoter: a.g.promoterName || '',
          arrival: a.g.arrivedAt || ''
        });
      });
    });
    pending.forEach(r => {
      listRows.push({ section: 'Waiting', position: 0, name: nameOf(r), promoter: r.promoterName || '', arrival: '' });
    });
    const listReport = {
      header: {
        title: eventDoc.title || '',
        venue: eventDoc.venueName || '',
        arrived: arrived.length,
        waiting: pending.length,
        total: regs.length
      },
      rows: listRows
    };

    // ── Report 2: exact replica of the admin Export button's rollup ──
    const normName = (n) => (n || '').toLowerCase().trim();
    const presentPromoters = new Set(
      promoters.filter(pr => (pr.attendedEventIds || []).indexOf(eventId) !== -1).map(pr => normName(pr.name))
    );
    const countByPromoter = (guests) => {
      const map = {};
      guests.forEach(g => {
        const key = g.promoterName || '—';
        if (!(key in map)) map[key] = 0;
        if (normName(g.guestName) === normName(key)) return // self-attendance, not an invited guest
        map[key]++;
      });
      return Object.entries(map).sort((a, b) => b[1] - a[1]);
    };
    const flatArrived = arrived.map(a => Object.assign({}, a.g, { group: a.group }));
    const byGroup = (tag) => flatArrived.filter(g =>
      tag === '' ? (g.group !== 'P' && g.group !== 'AP' && g.group !== 'LAP') : g.group === tag);
    const partyGuests = byGroup('P');
    const apGuests = byGroup('AP');
    const lapGuests = byGroup('LAP');
    const extraGuests = byGroup('');
    const dutyNames = new Set(dutyStaff.map(s => normName(s.name)));
    const staffPhones = new Set(
      staffList.filter(s => s.role !== 'admin').map(s => normalizePhoneKey(s.phone)).filter(Boolean)
    );
    const promoterPhones = new Set(
      promoters.map(pr => normalizePhoneKey(pr.phone)).filter(Boolean)
    );
    const internalPresent = new Set(dutyNames);
    flatArrived.forEach(g => {
      if (staffPhones.has(normalizePhoneKey(g.phone)) || promoterPhones.has(normalizePhoneKey(g.phone))) {
        internalPresent.add(normName(g.guestName));
      }
    });
    const totalByPromoter = {};
    flatArrived.forEach(g => {
      const key = normName(g.promoterName);
      if (key && key !== '—') totalByPromoter[key] = (totalByPromoter[key] || 0) + 1;
    });
    const starred = new Set();
    const presenceRoster = [];
    const seenRoster = new Set();
    const pushRoster = (name) => {
      const key = normName(name);
      if (!key || seenRoster.has(key)) return
      seenRoster.add(key);
      presenceRoster.push(name);
    };
    dutyStaff.forEach(s => pushRoster(s.name));
    flatArrived.forEach(g => {
      if (staffPhones.has(normalizePhoneKey(g.phone)) || promoterPhones.has(normalizePhoneKey(g.phone))) {
        pushRoster(g.guestName);
      }
    });
    const shortDate = eventDoc.date ? String(eventDoc.date).split('-').slice(1).reverse().join('/') : '';
    const rows = [];
    rows.push([eventDoc.title || '']);
    rows.push([eventDoc.venueName || '']);
    if (shortDate) rows.push([shortDate]);
    rows.push([]);
    const addSection = (title, guests, includeDuty) => {
      rows.push([title]);
      if (includeDuty) {
        // Present-but-invited-nobody internals: acknowledged once here.
        presenceRoster.forEach(name => {
          const key = normName(name);
          if ((totalByPromoter[key] || 0) > 0) return;
          rows.push([name + ' *']);
          starred.add(key);
        });
      }
      countByPromoter(guests).forEach(([name, count]) => {
        const key = normName(name);
        const isPresent = internalPresent.has(key) || presentPromoters.has(key);
        let marker = '';
        if (isPresent && !starred.has(key)) {
          marker = ' *';
          starred.add(key);
        }
        rows.push(count > 0 ? [name + marker, count] : [name + marker]);
      });
    };
    if (dutyStaff.length > 0 || partyGuests.length > 0) addSection('Party', partyGuests, true);
    if (apGuests.length > 0) { rows.push([]); addSection('After Party', apGuests, false); }
    if (lapGuests.length > 0) { rows.push([]); addSection('Late After Party', lapGuests, false); }
    if (extraGuests.length > 0) { rows.push([]); addSection('Extra', extraGuests, false); }

    await db.collection('reports').doc('r_' + eventId).set({
      data: {
        eventId,
        eventTitle: eventDoc.title || '',
        venueName: eventDoc.venueName || '',
        eventDate: eventDoc.date || '',
        closedAt: db.serverDate(),
        listReport,
        promoterReport: { rows },
        paidTicketsReport: regs.filter(r => r.paid).map(r => ({
          guestName: r.guestName || '',
          promoterName: r.promoterName || ''
        }))
      }
    });
    return { ok: true, total: regs.length };
  } catch (e) {
    console.error('buildEventReports failed:', e && e.message);
    return { ok: false };
  }
}

// 7-day retention (the reports design): a closed event's registrations live
// for a week — corrections, late look-ups — then the frozen reports fully
// replace the raw rows and they are deleted. The event doc stays as a small
// stub so Past Events and report downloads keep working. Runs from the timer
// trigger (keep-warm sweep); capped at a few events per run so the sweep
// converges without ever doing a giant burst.
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

async function archiveClosedEvents(db) {
  try {
    const _ = db.command;
    const cutoff = new Date(Date.now() - ARCHIVE_AFTER_MS);
    const res = await db.collection('events')
      .where({
        isClosed: true,
        archived: _.neq(true),
        closedAt: _.or([_.lt(cutoff), _.exists(false)])
      })
      .limit(3)
      .get();
    const due = res.data || [];
    let archivedCount = 0;
    for (const ev of due) {
      try {
        // Reports MUST exist before the rows die — rebuild if the close-time
        // build failed; if that still fails, skip and retry next sweep.
        if (!ev.hasReports) {
          const rep = await buildEventReports(db, ev);
          if (!rep || !rep.ok) continue;
        }
        // Delete the event's registrations, first-1000-at-a-time (removing
        // shifts offsets, so a skip cursor would drift).
        for (let pass = 0; pass < 50; pass++) {
          const regs = await db.collection('registrations')
            .where({ eventId: ev._id })
            .field({ _id: true })
            .limit(1000)
            .get();
          const rows = regs.data || [];
          if (rows.length === 0) break;
          await Promise.all(rows.map(r => db.collection('registrations').doc(r._id).remove().catch(() => {})));
        }
        await db.collection('events').doc(ev._id).update({
          data: {
            archived: true,
            archivedAt: db.serverDate(),
            description: '',
            guestCount: 0,
            updatedAt: db.serverDate()
          }
        });
        archivedCount++;
      } catch (e) { /* next sweep retries this event */ }
    }
    return { success: true, archived: archivedCount, candidates: due.length };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// Compatible event-deletion hotfix: no auth, environment or payment changes.
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

exports.main = async (event, context) => {
  // Scheduled trigger (timer): keep-warm + the 7-day archival sweep in one
  // cheap call. Timer invocations carry no caller identity, so this runs
  // BEFORE the staff gate below.
  // A REAL timer invocation carries no caller identity; a client call does
  // (OPENID/FROM_OPENID) — so a spoofed {Type:'Timer'} payload from the app
  // side falls through to the auth gate instead of running the archival.
  const wxCtx = cloud.getWXContext();
  if ((event.Type === 'Timer' || event.triggerName) && !wxCtx.OPENID && !wxCtx.FROM_OPENID) {
    return archiveClosedEvents(db);
  }

  const { action, id, eventId, status } = event;

  const caller = await getCallerStaff(db);
  if (!caller) {
    return { success: false, message: 'Unauthorized' };
  }
  const COUNTER_ALLOWED_ACTIONS = ['getRegistrations', 'getPromoters', 'getEventPromoters', 'getPromoterGuests', 'markAttendance', 'uncheckGuest', 'verifyVenuePassword', 'getEvents', 'issueCheckinToken'];
  if (caller.role !== 'admin' && !COUNTER_ALLOWED_ACTIONS.includes(action)) {
    return { success: false, message: 'Forbidden' };
  }

  // GET TEMP FILE URLS (resolves cloud:// IDs server-side for any user)
  if (action === 'getTempFileURLs') {
    try {
      const { fileList } = event;
      if (!fileList || fileList.length === 0) return { success: true, urlMap: {} };
      const res = await cloud.getTempFileURL({ fileList });
      const urlMap = {};
      res.fileList.forEach(f => { if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL; });
      return { success: true, urlMap };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET ALL GUESTS (from guests collection) — LEGACY BRIDGE.
  // Ships the roster in ONE reply, which stopped fitting the ~1MB callFunction
  // cap once the guest base passed a few thousand ("Load failed" on All
  // Guests / Promoters). The paged replacement is getGuestsPage below; this
  // action stays only for the published app until its upload and now returns
  // at most the newest 2000 rows (comfortably under the cap), with hasMore
  // flagging truncation.
  if (action === 'getAllGuests') {
    try {
      const BATCH = 1000;
      const MAX_ROWS = 2000;
      const data = [];
      const seen = new Set();
      let exhausted = false;
      for (let batch = 0; batch < 50 && data.length < MAX_ROWS; batch++) {
        const res = await db.collection('guests')
          .orderBy('createdAt', 'desc')
          .skip(batch * BATCH)
          .limit(BATCH)
          .field({
            _id: true,
            nickName: true,
            phone: true,
            promoCode: true,
            promoterId: true,
            promoterName: true,
            createdAt: true
          })
          .get();
        const page = res.data || [];
        page.forEach(g => {
          if (!seen.has(g._id)) {
            seen.add(g._id);
            data.push(g);
          }
        });
        if (page.length < BATCH) { exhausted = true; break; }
      }

      return {
        success: true,
        data,
        total: data.length,
        hasMore: !exhausted
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // GET GUESTS PAGE — the paged All-Guests read. Search (name OR phone,
  // case-insensitive contains) and the promoter filter (by promoterId) run
  // SERVER-side so they cover the whole roster, not just the loaded page;
  // each reply carries one small page plus the filtered total. Fields stay
  // whitelisted so a page's size is bounded no matter how the roster grows.
  if (action === 'getGuestsPage') {
    try {
      const _ = db.command;
      const OFFSET = Math.max(Number(event.offset) || 0, 0);
      const LIMIT = Math.min(Math.max(Number(event.limit) || 200, 1), 1000);
      const search = String(event.search || '').trim();
      // Escape regex metacharacters — user input must never become a pattern.
      const esc = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const conds = [];
      if (event.promoterId !== undefined && event.promoterId !== null) {
        conds.push({ promoterId: event.promoterId });
      }
      if (esc) {
        const re = db.RegExp({ regexp: esc, options: 'i' });
        conds.push(_.or([{ nickName: re }, { phone: re }]));
      }
      const where = conds.length === 0 ? {} : (conds.length === 1 ? conds[0] : _.and(conds));
      const [pageRes, countRes] = await Promise.all([
        db.collection('guests')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(OFFSET)
          .limit(LIMIT)
          .field({
            _id: true,
            nickName: true,
            phone: true,
            promoCode: true,
            promoterId: true,
            promoterName: true,
            createdAt: true
          })
          .get(),
        db.collection('guests').where(where).count()
      ]);
      const data = pageRes.data || [];
      const total = (countRes && countRes.total) || 0;
      return { success: true, data, total, hasMore: OFFSET + data.length < total };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET PROMOTER GUEST COUNTS — per-promoter guest totals without shipping
  // the roster: a promoterId/promoCode-only scan (tiny rows) walked in
  // 1000-doc batches, counted server-side. counts keys on promoterId;
  // codeCounts keys on the UPPER-cased promoCode for legacy rows written
  // before promoterId was stored — the same matching the promoter page did
  // client-side over the full roster.
  if (action === 'getPromoterGuestCounts') {
    try {
      const counts = {};
      const codeCounts = {};
      const BATCH = 1000;
      for (let offset = 0; offset < 100000; offset += BATCH) {
        const res = await db.collection('guests')
          .field({ promoterId: true, promoCode: true })
          .skip(offset)
          .limit(BATCH)
          .get();
        const docs = res.data || [];
        docs.forEach(g => {
          if (g.promoterId) counts[g.promoterId] = (counts[g.promoterId] || 0) + 1;
          const code = (g.promoCode || '').toUpperCase();
          if (code) codeCounts[code] = (codeCounts[code] || 0) + 1;
        });
        if (docs.length < BATCH) break;
      }
      return { success: true, counts, codeCounts };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET EVENTS — the ONLY way the client may list events. A query issued from the
  // miniprogram client is hard-capped at 20 docs no matter what .limit() says; only a
  // cloud function gets the 1000 ceiling. Ordered ascending, that cap returned the
  // OLDEST 20 events and today's event never arrived (calendar page, counter workspace).
  // Params are all optional and combine: dateFrom/dateTo (inclusive range), dateGte
  // (lower bound only), venueName (exact).
  if (action === 'getEvents') {
    try {
      const { dateFrom, dateTo, dateGte, venueName } = event;
      const _ = db.command;
      const where = {};
      if (venueName) where.venueName = venueName;
      if (dateFrom && dateTo) where.date = _.gte(dateFrom).and(_.lte(dateTo));
      else if (dateFrom) where.date = _.gte(dateFrom);
      else if (dateTo) where.date = _.lte(dateTo);
      else if (dateGte) where.date = _.gte(dateGte);
      const res = await db.collection('events')
        .where(where)
        .orderBy('date', 'asc')
        .limit(1000)
        .get();
      return { success: true, data: res.data || [] };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET REGISTRATIONS (paginated)
  if (action === 'getRegistrations') {
    try {
      const _ = db.command;
      // Pagination: the joined payload (registration + phone) grew past the
      // ~1MB callFunction reply cap on big events, failing the WHOLE call and
      // blanking the admin page. Heavy docs are now served page by page
      // (orderBy promoterName is stable, so skip/limit pages append cleanly),
      // and guestAvatar — the single longest field, unused by every list UI —
      // is projected out: ~1000 docs fit comfortably under the cap with it
      // gone. Two tiny extras keep the page's global numbers honest: the
      // total count and the arrival timestamps of every arrived guest.
      const PAGE_LIMIT = Math.min(Math.max(Number(event.limit) || 1000, 1), 1000);
      const OFFSET = Math.max(Number(event.offset) || 0, 0);

      // DELTA MODE — liveSync-driven refreshes. Only rows touched since the
      // caller's last sync travel back (server clock — every response of
      // this action carries serverNow), plus the tiny globals the pages
      // rebuild their views from. One check-in = one row over the wire
      // instead of the whole guest list. The change channel is the write
      // timestamps (createdAt/scannedAt/checkedInAt/updatedAt); anything
      // outside it (legacy un-checkes) is caught by the clients' periodic
      // FULL refresh, which stays the safety net.
      const SINCE = Number(event.since) || 0;
      if (SINCE > 0) {
        const sinceDate = new Date(SINCE);
        const [changedRes, eventRes, dutyStaffRes, countRes, arrivedTimesRes, promNamesRes] = await Promise.all([
          db.collection('registrations')
            .where(_.and([
              { eventId: event.eventId },
              _.or([
                { createdAt: _.gt(sinceDate) },
                { scannedAt: _.gt(sinceDate) },
                { checkedInAt: _.gt(sinceDate) },
                { updatedAt: _.gt(sinceDate) }
              ])
            ]))
            .limit(500)
            .field(REG_FIELDS)
            .get(),
          db.collection('events').doc(event.eventId).get().catch(() => ({ data: {} })),
          db.collection('staff')
            .where({ workedEventIds: event.eventId })
            .field({ _id: true, name: true })
            .get()
            .catch(() => ({ data: [] })),
          db.collection('registrations').where({ eventId: event.eventId }).count(),
          db.collection('registrations')
            .where({ eventId: event.eventId, arrivedAt: _.exists(true) })
            .field({ arrivedAt: true, checkedInAt: true })
            .limit(1000)
            .get(),
          db.collection('registrations')
            .where({ eventId: event.eventId })
            .field({ promoterName: true })
            .limit(1000)
            .get()
        ]);
        const changed = changedRes.data || [];
        const healedPhones = await healGuestPhones(db, changed);
        const data = changed.map(r => Object.assign({}, r, { phone: r.guestPhone || healedPhones[r._openid] || '' }));
        return {
          success: true,
          delta: true,
          changed: data,
          event: eventRes.data,
          dutyStaff: dutyStaffRes.data || [],
          total: (countRes && countRes.total) || 0,
          promoterNames: [...new Set(
            (promNamesRes.data || []).map(r => r.promoterName).filter(Boolean)
          )].sort(),
          arrivedTimes: (arrivedTimesRes.data || [])
            .filter(r => r.arrivedAt)
            .map(r => ({ arrivedAt: r.arrivedAt || '', checkedInAt: r.checkedInAt || null })),
          serverNow: Date.now(),
          hasMore: false
        };
      }

      const [regsRes, eventRes, dutyStaffRes, countRes] = await Promise.all([
        db.collection('registrations')
          .where({ eventId: event.eventId })
          .orderBy('promoterName', 'asc')
          .skip(OFFSET)
          .limit(PAGE_LIMIT)
          .field(REG_FIELDS)
          .get(),
        // A missing/stale event doc must not take the whole response down —
        // the list itself is still perfectly renderable.
        db.collection('events').doc(event.eventId).get().catch(() => ({ data: {} })),
        // Staff who worked this event (workedEventIds is the sole source of truth) —
        // returned server-side so the client never reads the staff collection directly.
        db.collection('staff')
          .where({ workedEventIds: event.eventId })
          .field({ _id: true, name: true })
          .get()
          .catch(() => ({ data: [] })),
        db.collection('registrations').where({ eventId: event.eventId }).count()
      ]);
      const regs = regsRes.data || [];
      const total = (countRes && countRes.total) || 0;

      // Keep the event's stored guest counter exact for free — this count()
      // happens anyway; syncing it here costs zero extra queries (the read
      // side is attachGuestCounts in getEventsWithGuestCounts).
      if (eventRes.data && eventRes.data.guestCount !== total) {
        await db.collection('events').doc(event.eventId).update({
          data: { guestCount: total, guestCountSyncedAt: db.serverDate() }
        }).catch(() => {});
      }

      // Single-page fast path: when this ONE response already carries every
      // registration of the event (offset 0 and the page covers the total),
      // the two extra event-wide scans below are pure duplicates — derive the
      // arrival timestamps and the distinct promoter names from the docs
      // already in hand. That halves the heavy queries on exactly the events
      // the admin opens most (≤1000 guests), which matters while the function
      // still runs under a tight timeout. The scans stay for genuinely
      // paginated events, where the client assembles pages across calls.
      let arrivedTimes;
      let promoterNames;
      if (OFFSET === 0 && regs.length >= total) {
        arrivedTimes = regs
          .filter(r => r.arrivedAt)
          .map(r => ({ arrivedAt: r.arrivedAt || '', checkedInAt: r.checkedInAt || null }));
        promoterNames = [...new Set(regs.map(r => r.promoterName).filter(Boolean))].sort();
      } else {
        const [arrivedTimesRes, promNamesRes] = await Promise.all([
          db.collection('registrations')
            .where({ eventId: event.eventId, arrivedAt: _.exists(true) })
            .field({ arrivedAt: true, checkedInAt: true })
            .limit(1000)
            .get(),
          // Distinct promoter names for the filter chips — a names-only scan,
          // so the chip bar is COMPLETE from the first response regardless of
          // how many heavy registration docs are loaded/paginated.
          db.collection('registrations')
            .where({ eventId: event.eventId })
            .field({ promoterName: true })
            .limit(1000)
            .get()
        ]);
        // Truthiness filter: uncheckGuest leaves arrivedAt:null behind, which
        // _.exists(true) still matches — those rows must not count as arrivals.
        arrivedTimes = (arrivedTimesRes.data || [])
          .filter(r => r.arrivedAt)
          .map(r => ({ arrivedAt: r.arrivedAt || '', checkedInAt: r.checkedInAt || null }));
        promoterNames = [...new Set(
          (promNamesRes.data || []).map(r => r.promoterName).filter(Boolean)
        )].sort();
      }

      // Attach the phone (invisible STAFF/PROMOTER badge key, XLS presence
      // stars). Served from the registration's own guestPhone snapshot; rows
      // that predate the snapshot are healed from the guest profile once and
      // written back (see healGuestPhones) — no per-call join with the
      // ever-growing guests collection.
      const healedPhones = await healGuestPhones(db, regs);
      const data = regs.map(r => Object.assign({}, r, { phone: r.guestPhone || healedPhones[r._openid] || '' }));

      return {
        success: true,
        data,
        event: eventRes.data,
        dutyStaff: dutyStaffRes.data || [],
        total,
        promoterNames,
        arrivedTimes,
        hasMore: OFFSET + regs.length < total,
        // Server clock for the clients' delta cursor (see the since branch
        // above) — client clocks must never gate server-written timestamps.
        serverNow: Date.now()
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // GET EVENT PROMOTERS — the chip roster as its OWN lightweight request, so
  // the chips render before any heavy guest page is fetched (names-only scan,
  // exactly one small query). getRegistrations keeps returning promoterNames
  // for backward compatibility with the published app.
  if (action === 'getEventPromoters') {
    try {
      if (!eventId) return { success: false, message: 'No eventId' };
      const res = await db.collection('registrations')
        .where({ eventId })
        .field({ promoterName: true })
        .limit(1000)
        .get();
      const promoterNames = [...new Set(
        (res.data || []).map(r => r.promoterName).filter(Boolean)
      )].sort();
      return { success: true, promoterNames };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET PROMOTER GUESTS — every registration of ONE promoter on ONE event.
  // This is the completeness guarantee behind the promoter chips: the answer
  // is a server query scoped by (eventId, promoterName), never "whatever page
  // of the list happens to be loaded" — it stays complete when the list UIs
  // move to paged browsing.
  if (action === 'getPromoterGuests') {
    try {
      const { promoterName } = event;
      if (!eventId || !promoterName) return { success: false, message: 'No eventId or promoterName' };
      const res = await db.collection('registrations')
        .where({ eventId, promoterName })
        .orderBy('createdAt', 'asc')
        .limit(1000)
        .field(REG_FIELDS)
        .get();
      const regs = res.data || [];
      const healedPhones = await healGuestPhones(db, regs);
      const data = regs.map(r => Object.assign({}, r, { phone: r.guestPhone || healedPhones[r._openid] || '' }));
      return { success: true, data, total: data.length };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET PROMOTERS
  if (action === 'getPromoters') {
    try {
      // Explicit limit: an unbounded .get() silently caps the result set, which
      // truncated the "Change Promoter" sheet to the first handful of promoters.
      // The limit is what makes this return the full roster.
      const res = await db.collection('promoters').orderBy('createdAt', 'desc').limit(1000).get();
      return { success: true, data: res.data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // UPDATE PROMOTER STATUS
  if (action === 'updatePromoterStatus') {
    try {
      await db.collection('promoters').doc(id).update({
        data: { status, updatedAt: db.serverDate() }
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // UPDATE PROMOTER (name and/or code and/or phone)
  if (action === 'updatePromoter') {
    try {
      const { name, promoCode, phone } = event;
      if (!name && !promoCode && phone === undefined) return { success: false, message: 'Nothing to update' };
      if (promoCode) {
        const existing = await db.collection('promoters').where({ promoCode }).get();
        const taken = existing.data.filter(p => p._id !== id);
        if (taken.length > 0) return { success: false, message: 'Promo code already taken' };
      }
      // Read the current doc first so we know whether the name ACTUALLY changed —
      // no rename (or no name in the payload) means no cascade and no wasted writes.
      let oldName = '';
      try {
        const current = await db.collection('promoters').doc(id).get();
        oldName = (current.data && current.data.name) || '';
      } catch (e) {
        oldName = '';
      }
      const renamed = !!name && name !== oldName;

      const data = { updatedAt: db.serverDate() };
      if (name) data.name = name;
      if (promoCode) data.promoCode = promoCode;
      if (phone !== undefined) data.phone = phone;
      await db.collection('promoters').doc(id).update({ data });

      // CASCADE THE RENAME — promoterName is denormalized into guests and
      // registrations, and every grouping/count in the admin + counter UI compares
      // that STRING (work.js, guests.js, event-guests.js). Left alone, a rename
      // splits the promoter's guest group in two and breaks the event report's
      // invited-guest counts.
      //
      // ALL history is rewritten here, closed/past events included: a rename means
      // the same person changed their name, so every record should carry one
      // consistent name. This deliberately differs from updateGuestPromoter below,
      // which only rewrites UPCOMING events — that action REASSIGNS a guest to a
      // DIFFERENT promoter, so rewriting history there would falsify past
      // attribution. Same-person rename vs. different-person reassignment.
      //
      // Isolated: a failure here must never fail the promoters-doc rename above.
      let updatedGuests = 0;
      let updatedRegistrations = 0;
      if (renamed) {
        const _ = db.command;
        // .where().update() writes at most 1000 docs per call and registrations can
        // be far larger. Selecting on "promoterName is not yet the new name" means
        // every pass shrinks its own match set, so looping until stats.updated is 0
        // converges without a cursor. Capped at 50 passes (50k docs) so a bad
        // selector can never spin forever.
        const cascade = async (collectionName, selector) => {
          let total = 0;
          for (let pass = 0; pass < 50; pass++) {
            const res = await db.collection(collectionName).where(selector).update({
              data: { promoterName: name }
            });
            const n = (res.stats && res.stats.updated) || 0;
            total += n;
            if (n === 0) break;
          }
          return total;
        };

        // Match by promoterId, never by the old name: the id still matches records
        // that are already inconsistent, and it cannot catch a different promoter
        // who happens to share the name.
        try {
          updatedGuests += await cascade('guests', { promoterId: id, promoterName: _.neq(name) });
          updatedRegistrations += await cascade('registrations', { promoterId: id, promoterName: _.neq(name) });
        } catch (e) {
          console.error('updatePromoter: promoterId cascade failed', e);
        }

        // Legacy rows only: docs written before promoterId was stored alongside
        // promoterName have no id to match on, so exact old-name match is the only
        // handle left. Scoped to docs with a missing/empty promoterId so a namesake
        // promoter's records can never be caught. promoterId is deliberately NOT
        // backfilled here — a name match is not proof of ownership.
        if (oldName) {
          const legacy = _.or([
            { promoterName: oldName, promoterId: _.exists(false) },
            { promoterName: oldName, promoterId: '' }
          ]);
          try {
            updatedGuests += await cascade('guests', legacy);
            updatedRegistrations += await cascade('registrations', legacy);
          } catch (e) {
            console.error('updatePromoter: legacy name cascade failed', e);
          }
        }
      }

      return { success: true, updatedGuests, updatedRegistrations };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // DELETE PROMOTER — guests referencing this promoter must be reassigned first
  // (or explicitly unassigned), never silently orphaned. Two-phase: called without
  // reassignToPromoterId, this refuses and reports affectedCount so the client can
  // prompt for a replacement; called again with reassignToPromoterId (a promoter
  // _id, or '' to mean "no replacement"), it reassigns then deletes.
  if (action === 'deletePromoter') {
    try {
      if (!id) return { success: false, message: 'No ID provided' };
      const { reassignToPromoterId } = event;

      const affected = await db.collection('guests').where({ promoterId: id }).field({ _id: true }).limit(1000).get();
      const affectedCount = (affected.data || []).length;

      if (affectedCount > 0 && reassignToPromoterId === undefined) {
        // Caller hasn't decided yet — refuse and report how many guests are affected
        // so the client can prompt for a replacement (or explicit unassignment).
        return { success: false, requiresReassignment: true, affectedCount };
      }

      if (affectedCount > 0) {
        // promoCode moves with promoterId/promoterName — the All Guests filter groups
        // by promoCode, so a stale code would keep the guest under the deleted promoter.
        let newName = '';
        let newCode = '';
        if (reassignToPromoterId) {
          const target = await db.collection('promoters').doc(reassignToPromoterId).get();
          newName = (target.data && target.data.name) || '';
          newCode = (target.data && target.data.promoCode) || '';
        }
        await Promise.all(
          affected.data.map(g => db.collection('guests').doc(g._id).update({
            data: { promoterId: reassignToPromoterId || '', promoterName: newName, promoCode: newCode }
          }))
        );
      }

      await db.collection('promoters').doc(id).remove();
      return { success: true, reassignedCount: affectedCount };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ISSUE CHECK-IN TOKEN — called by the counter's QR overlay. The token binds
  // ONE event (the one the counter is working, identified by the event doc
  // existing — no venue cross-check needed, the workspace is already inside
  // the venue session) and expires in CHECKIN_TTL_SEC. Guests scan it, the
  // guest app validates via clientAuth — see the shared-secret note above.
  if (action === 'issueCheckinToken') {
    try {
      if (!eventId) return { success: false, message: 'No eventId' };
      // Confirm the event exists (and echo its title for the overlay header).
      const evRes = await db.collection('events').doc(eventId).get().catch(() => null);
      if (!evRes || !evRes.data) return { success: false, message: 'Event not found' };
      const exp = Math.floor(Date.now() / 1000) + CHECKIN_TTL_SEC;
      return {
        success: true,
        token: createCheckinToken(eventId, exp),
        expiresAt: exp,
        ttl: CHECKIN_TTL_SEC,
        eventTitle: evRes.data.title || ''
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // MARK ATTENDANCE — unified staff/promoter "physically present at this event" toggle,
  // used by the counter's guest-list view. Read-then-write (not db.command.push/pull)
  // deliberately, to avoid edge cases with a field that may not exist yet on older docs.
  if (action === 'markAttendance') {
    try {
      const { targetType, targetId, eventId, present } = event;
      if (!targetType || !targetId || !eventId) return { success: false, message: 'Missing params' };
      const collectionName = targetType === 'staff' ? 'staff' : 'promoters';
      const fieldName = targetType === 'staff' ? 'workedEventIds' : 'attendedEventIds';
      const doc = await db.collection(collectionName).doc(targetId).get();
      const current = (doc.data && doc.data[fieldName]) || [];
      let next;
      if (present) {
        next = current.includes(eventId) ? current : [...current, eventId];
      } else {
        next = current.filter(id => id !== eventId);
      }
      await db.collection(collectionName).doc(targetId).update({ data: { [fieldName]: next } });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // SAVE EVENT (create or update)
  if (action === 'saveEvent') {
    try {
      const { id, eventData } = event;
      if (!eventData) return { success: false, message: 'No event data' };
      const now = db.serverDate();
      if (id) {
        await db.collection('events').doc(id).update({ data: { ...eventData, updatedAt: now } });
        return { success: true, id };
      } else {
        const res = await db.collection('events').add({ data: { ...eventData, status: 'active', createdAt: now, updatedAt: now } });
        return { success: true, id: res._id };
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // DELETE EVENT
  if (action === 'deleteEvent') {
    return deleteEventSafely(db, eventId || id, context);
  }

  // UNCHECK GUEST
  if (action === 'uncheckGuest') {
    try {
      const { registrationId } = event;
      if (!registrationId) return { success: false, message: 'No registrationId' };
      await db.collection('registrations').doc(registrationId).update({
        data: { arrivedAt: null, checkedInAt: null, scannedAt: null, updatedAt: db.serverDate() }
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // CREATE PROMOTER
  if (action === 'createPromoter') {
    try {
      const { name, promoCode, phone } = event;
      if (!name || !promoCode) {
        return { success: false, message: 'Name and promo code required' };
      }
      const existing = await db.collection('promoters').where({ promoCode }).get();
      if (existing.data.length > 0) {
        return { success: false, message: 'Promo code already taken' };
      }
      const res = await db.collection('promoters').add({
        data: {
          name,
          promoCode,
          phone: (phone || '').trim(),
          avatarUrl: '',
          status: 'approved',
          totalGuests: 0,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { success: true, promoterId: res._id };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // VERIFY VENUE PASSWORD — counter door-login (caller is already a logged-in staff
  // member, enforced by the getCallerStaff gate above). Returns only id + name;
  // never echoes the password back to the client.
  if (action === 'verifyVenuePassword') {
    try {
      const { password } = event;
      const code = (password || '').trim();
      if (!code) return { success: false, message: 'Invalid password' };
      const res = await db.collection('venues').where({ password: code }).limit(1).get();
      if (!res.data || res.data.length === 0) {
        return { success: false, message: 'Invalid password' };
      }
      const venue = res.data[0];
      return { success: true, venue: { _id: venue._id, name: venue.name } };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET VENUES — admin venue management (venue-list / venue-edit / event-edit).
  // Admin-only (not in COUNTER_ALLOWED_ACTIONS). Includes the password field because
  // the admin UI displays and edits it. Replaces direct client reads of the collection
  // so it can be locked down to no-client-access.
  if (action === 'getVenues') {
    try {
      if (id) {
        const res = await db.collection('venues').doc(id).get();
        return { success: true, data: res.data ? [res.data] : [] };
      }
      // Same unbounded-.get() cap as getPromoters — the venue list must not truncate.
      const res = await db.collection('venues').limit(1000).get();
      return { success: true, data: res.data || [] };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // VENUE GALLERY — admin edits photos of a venue from its card. `add` /
  // `remove` carry cloud:// fileIDs; removed files are also deleted from
  // storage so the gallery never leaves orphaned junk behind. This is the
  // data source of the guest app's Gallery tiles (getVenueGalleries in
  // clientAuth).
  if (action === 'updateVenueGallery') {
    try {
      const { id, add, remove } = event;
      if (!id) return { success: false, message: 'No venue id' };
      const addList = Array.isArray(add) ? add.filter(Boolean) : [];
      const removeList = Array.isArray(remove) ? remove.filter(Boolean) : [];
      const docRes = await db.collection('venues').doc(id).get();
      const current = Array.isArray(docRes.data && docRes.data.galleryImages) ? docRes.data.galleryImages : [];
      let next = current.filter(f => removeList.indexOf(f) === -1);
      addList.forEach(f => { if (next.indexOf(f) === -1) next.push(f); });
      await db.collection('venues').doc(id).update({
        data: { galleryImages: next, updatedAt: db.serverDate() }
      });
      if (removeList.length > 0) {
        await cloud.deleteFile({ fileList: removeList }).catch(() => {});
      }
      return { success: true, galleryImages: next };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // SAVE VENUE (create or update)
  if (action === 'saveVenue') {
    try {
      const { name, password, address, latitude, longitude } = event;
      if (!name || !password) return { success: false, message: 'Name and password required' };
      const venueData = {
        name: name.trim(),
        password: password.trim(),
        address: address || '',
        latitude: latitude || 0,
        longitude: longitude || 0,
        updatedAt: db.serverDate()
      };
      if (id) {
        await db.collection('venues').doc(id).update({ data: venueData });
        return { success: true, id };
      } else {
        const res = await db.collection('venues').add({ data: { ...venueData, createdAt: db.serverDate() } });
        return { success: true, id: res._id };
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // DELETE VENUE
  if (action === 'deleteVenue') {
    try {
      if (!id) return { success: false, message: 'No ID provided' };
      await db.collection('venues').doc(id).remove();
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ─── One-shot hygiene actions (admin-only) ─────────────────────────────────
  //
  // CLEANUP ORPHAN REGISTRATIONS — removes registrations whose eventId points
  // to a deleted event. Those rows are dead tickets in guests' My List: the
  // event page can't load, and they pollute counts. dryRun=true only reports.
  if (action === 'cleanupOrphanRegistrations') {
    try {
      const evRes = await db.collection('events').field({ _id: true }).limit(1000).get();
      const liveIds = new Set((evRes.data || []).map(e => e._id));
      const orphans = [];
      const BATCH = 1000;
      for (let offset = 0; offset < 50000; offset += BATCH) {
        const res = await db.collection('registrations')
          .field({ _id: true, eventId: true, eventTitle: true })
          .skip(offset)
          .limit(BATCH)
          .get();
        const docs = res.data || [];
        docs.forEach(r => { if (!liveIds.has(r.eventId)) orphans.push(r) });
        if (docs.length < BATCH) break;
      }
      if (event.dryRun) {
        return { success: true, dryRun: true, orphanCount: orphans.length,
          sample: orphans.slice(0, 10).map(r => ({ eventTitle: r.eventTitle || '—' })) };
      }
      for (const r of orphans) {
        await db.collection('registrations').doc(r._id).remove();
      }
      return { success: true, removed: orphans.length };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // DEDUPE REGISTRATIONS — one registration per (event, guest). Rows written
  // before the deterministic-_id fix could double up on a double-tap/retry.
  // Keeps the "best" row per key (arrivedAt, then scannedAt, then earliest
  // createdAt) and removes the rest. dryRun reports.
  if (action === 'dedupeRegistrations') {
    try {
      const byKey = {};
      const BATCH = 1000;
      for (let offset = 0; offset < 50000; offset += BATCH) {
        const res = await db.collection('registrations')
          .field({ _id: true, _openid: true, eventId: true, eventTitle: true, guestName: true, arrivedAt: true, scannedAt: true, createdAt: true })
          .skip(offset)
          .limit(BATCH)
          .get();
        const docs = res.data || [];
        docs.forEach(r => {
          const key = r.eventId + '|' + (r._openid || '?');
          (byKey[key] = byKey[key] || []).push(r);
        });
        if (docs.length < BATCH) break;
      }
      const rank = (r) => (r.arrivedAt ? 3 : 0) + (r.scannedAt ? 2 : 0);
      const createdMs = (r) => {
        const v = r.createdAt;
        const raw = (typeof v === 'object' && v !== null && v.$date !== undefined) ? v.$date : v;
        const t = new Date(raw).getTime();
        return isNaN(t) ? Infinity : t;
      };
      const remove = [];
      Object.values(byKey).forEach(list => {
        if (list.length < 2) return;
        const keep = list.slice().sort((a, b) => rank(b) - rank(a) || createdMs(a) - createdMs(b))[0];
        list.forEach(r => { if (r._id !== keep._id) remove.push(r); });
      });
      if (event.dryRun) {
        return { success: true, dryRun: true, duplicateDocs: remove.length,
          sample: remove.slice(0, 10).map(r => ({ eventTitle: r.eventTitle || '—', guestName: r.guestName || '' })) };
      }
      for (const r of remove) {
        await db.collection('registrations').doc(r._id).remove();
      }
      // Removed duplicates mean stored guest counters are now overstated —
      // recount every affected event once so the Events tab heals immediately.
      const affectedIds = [...new Set(remove.map(r => r.eventId))];
      for (const evId of affectedIds) {
        try {
          const cnt = await db.collection('registrations').where({ eventId: evId }).count();
          await db.collection('events').doc(evId).update({
            data: { guestCount: cnt.total || 0, guestCountSyncedAt: db.serverDate() }
          }).catch(() => {});
        } catch (e) { /* lazy recount covers this elsewhere */ }
      }
      return { success: true, removed: remove.length };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // BACKFILL GUEST NAMES — registrations store a guestName snapshot taken at
  // signup; rows written while the name was lost to the nickname-input race
  // (or by since-deleted nameless profiles) show blank in every list. Patch
  // them from the CURRENT guest profile of the same openid. dryRun reports.
  if (action === 'backfillGuestNames') {
    try {
      const nameByOpenid = {};
      const GBATCH = 1000;
      for (let offset = 0; offset < 50000; offset += GBATCH) {
        const guestsRes = await db.collection('guests')
          .field({ _openid: true, nickName: true })
          .skip(offset)
          .limit(GBATCH)
          .get();
        const gDocs = guestsRes.data || [];
        gDocs.forEach(g => {
          if (g.nickName && String(g.nickName).trim() && g._openid) {
            nameByOpenid[g._openid] = String(g.nickName).trim();
          }
        });
        if (gDocs.length < GBATCH) break;
      }
      const fixes = [];
      const BATCH = 1000;
      for (let offset = 0; offset < 50000; offset += BATCH) {
        const res = await db.collection('registrations')
          .field({ _id: true, _openid: true, guestName: true })
          .skip(offset)
          .limit(BATCH)
          .get();
        const docs = res.data || [];
        docs.forEach(r => {
          const name = nameByOpenid[r._openid];
          if (name && (!r.guestName || !String(r.guestName).trim())) fixes.push({ _id: r._id, name });
        });
        if (docs.length < BATCH) break;
      }
      if (event.dryRun) {
        return { success: true, dryRun: true, fixableCount: fixes.length };
      }
      for (const f of fixes) {
        await db.collection('registrations').doc(f._id).update({ data: { guestName: f.name } });
      }
      return { success: true, patched: fixes.length };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // DELETE GUEST (admin-only) — removes a guest profile doc by _id. Per-event
  // registrations are keyed by _openid, not by the guest doc, so history stays
  // intact; only the roster entry disappears.
  if (action === 'deleteGuest') {
    try {
      if (!id) return { success: false, message: 'No ID provided' };
      await db.collection('guests').doc(id).remove();
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // CLOSE EVENT — mark event as closed
  if (action === 'closeEvent') {
    try {
      const { eventId, closedBy } = event;
      if (!eventId) return { success: false, message: 'No eventId' };
      // Closing freezes the two reports, then kills the photos (see
      // buildEventReports / purgeEventImages). Any failure inside is
      // swallowed — the close itself must always succeed.
      let purgedImages = 0;
      let reportBuilt = false;
      try {
        const evRes = await db.collection('events').doc(eventId).get();
        if (evRes && evRes.data) {
          const evDoc = Object.assign({ _id: eventId }, evRes.data);
          const rep = await buildEventReports(db, evDoc);
          reportBuilt = !!(rep && rep.ok);
          purgedImages = await purgeEventImages(db, evDoc);
        }
      } catch (e) { /* closing still proceeds */ }
      await db.collection('events').doc(eventId).update({
        data: {
          status: 'closed',
          isClosed: true,
          hasReports: reportBuilt,
          closedAt: db.serverDate(),
          closedBy: closedBy || 'Unknown'
        }
      });
      return { success: true, purgedImages, reportBuilt };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // CLEANUP CLOSED EVENT IMAGES — one-shot retro purge for events that were
  // closed before the purge-on-close policy existed. Idempotent: events with
  // already-blank image fields contribute nothing, so it is safe to re-run.
  // Trigger from the DevTools cloud console (云端测试) with {"action":"cleanupClosedEventImages"}.
  if (action === 'cleanupClosedEventImages') {
    try {
      const _ = db.command;
      const res = await db.collection('events').where({ isClosed: _.eq(true) }).limit(100).get();
      let purgedFiles = 0;
      let eventsCleaned = 0;
      for (const ev of (res.data || [])) {
        const n = await purgeEventImages(db, ev);
        if (n > 0) { purgedFiles += n; eventsCleaned++; }
      }
      return { success: true, purgedFiles, eventsCleaned };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // GET EVENT REPORT — serves a closed event's frozen reports. Events closed
  // before report generation existed get their report BUILT on demand
  // (registrations still exist until the archival phase) and cached in
  // `reports` — the first download backfills history by itself.
  if (action === 'getEventReport') {
    try {
      if (!eventId) return { success: false, message: 'No eventId' };
      const existing = await db.collection('reports').doc('r_' + eventId).get().catch(() => null);
      if (existing && existing.data) {
        return { success: true, report: existing.data };
      }
      const evRes = await db.collection('events').doc(eventId).get().catch(() => null);
      if (!evRes || !evRes.data) return { success: false, message: 'Event not found' };
      const built = await buildEventReports(db, Object.assign({ _id: eventId }, evRes.data));
      if (!built || !built.ok) return { success: false, message: 'Report could not be built' };
      const fresh = await db.collection('reports').doc('r_' + eventId).get().catch(() => null);
      return { success: true, report: (fresh && fresh.data) || null };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // UPDATE GUEST PROMOTER — reassigns the guest's promoter, and also rewrites the
  // promoter snapshot stored on that guest's registrations for UPCOMING events only.
  // Registrations carry their own promoterId/promoterName copied at signup time (the
  // counter workspace reads them from there, not from guests), so without this the
  // reassignment would never show up on the guest list. Past events are deliberately
  // left untouched so historical attribution / commission stats stay intact.
  if (action === 'updateGuestPromoter') {
    try {
      const { guestId, promoterId, promoterName } = event;
      if (!guestId) return { success: false, message: 'No guestId' };

      let guestOpenid = '';
      try {
        const guestDoc = await db.collection('guests').doc(guestId).get();
        guestOpenid = (guestDoc.data && guestDoc.data._openid) || '';
      } catch (e) {
        guestOpenid = '';
      }

      // promoCode is the stable key the All Guests filter groups by, so it MUST move
      // with promoterId/promoterName or the guest stays grouped under the old promoter.
      // Looked up server-side from the promoters collection (never taken from the
      // client) so the three fields can't disagree. Unassignment clears all three.
      let promoCode = '';
      if (promoterId) {
        const target = await db.collection('promoters').doc(promoterId).get();
        promoCode = (target.data && target.data.promoCode) || '';
      }

      await db.collection('guests').doc(guestId).update({
        data: { promoterId: promoterId || '', promoterName: promoterName || '', promoCode }
      });

      // Isolated: a failure here must never fail the guest-level reassignment above.
      let updatedRegistrations = 0;
      if (guestOpenid) {
        try {
          const _ = db.command;
          const todayStr = new Date().toISOString().split('T')[0];
          const regRes = await db.collection('registrations').where({
            _openid: guestOpenid,
            eventDate: _.gte(todayStr)
          }).update({
            // registrations carry their own promoCode snapshot (written by the guest
            // app's register.js / event-detail.js signup paths), so it cascades too.
            data: { promoterId: promoterId || '', promoterName: promoterName || '', promoCode }
          });
          updatedRegistrations = (regRes.stats && regRes.stats.updated) || 0;
        } catch (e) {
          console.error('updateGuestPromoter: registrations update failed', e);
          updatedRegistrations = 0;
        }
      }

      return { success: true, updatedRegistrations };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  if (action === 'getTeamCounts') {
    try {
      const [venues, staff, promoters, pending, guests] = await Promise.all([
        db.collection('venues').count(),
        db.collection('staff').where({ role: 'counter' }).count(),
        db.collection('promoters').count(),
        db.collection('promoters').where({ status: 'pending' }).count(),
        // registrations are one row per guest PER EVENT; guests are distinct people
        db.collection('guests').count()
      ]);
      return {
        success: true,
        venueCount: venues.total,
        staffCount: staff.total,
        promoterCount: promoters.total,
        pendingCount: pending.total,
        totalGuests: guests.total
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  if (action === 'getEventsWithGuestCounts') {
    try {
      const { dateFilter, mode } = event;
      if (!dateFilter) return { success: false, message: 'No dateFilter' };

      let eventsQuery;
      if (mode === 'past') {
        const _ = db.command;
        eventsQuery = db.collection('events')
          .where(_.or([{ date: _.lte(dateFilter) }, { isClosed: _.eq(true) }]))
          .orderBy('date', 'desc')
          .limit(50);
      } else if (mode === 'upcoming') {
        // STATUS-based, not time-window based: an event is current while
        // its isClosed flag is unset/false — no date arithmetic decides
        // visibility. Time only FLIPS the status (the admin's close button
        // elsewhere, or the lazy auto-close right below), matching the
        // admin model: "active until closed by button or by time".
        const _ = db.command;
        const openRes = await db.collection('events')
          .where({ isClosed: _.neq(true) })
          .orderBy('date', 'asc')
          .limit(100)
          .get();
        const openEvents = openRes.data || [];

        // Lazy auto-close: anything past its end time (endTime < 12:00 →
        // next day, the same night-event rule as everywhere else) gets the
        // flag stamped now, so ended events leave the active list the very
        // next time it is read — no one has to open them first.
        const nowMs = Date.now();
        const endedIds = [];
        for (const ev of openEvents) {
          if (!ev.date || !ev.endTime) continue;
          try {
            const [y, m, d] = String(ev.date).split('-').map(Number);
            const [h, min] = String(ev.endTime).split(':').map(Number);
            const endDt = new Date(y, m - 1, d, h, min, 0, 0);
            if (h < 12) endDt.setDate(endDt.getDate() + 1);
            if (!isNaN(endDt.getTime()) && nowMs > endDt.getTime()) endedIds.push(ev._id);
          } catch (e) { /* keep the event open on parse issues */ }
        }
        if (endedIds.length > 0) {
          // Auto-closed events get the same treatment as button-closed ones:
          // reports frozen first, photos purged, then the status flip.
          await Promise.all(openEvents
            .filter(ev => endedIds.indexOf(ev._id) !== -1)
            .map(async ev => {
              const rep = await buildEventReports(db, ev);
              await purgeEventImages(db, ev);
              await db.collection('events').doc(ev._id).update({
                data: {
                  isClosed: true,
                  closedBy: 'Auto',
                  hasReports: !!(rep && rep.ok),
                  closedAt: db.serverDate(),
                  updatedAt: db.serverDate()
                }
              }).catch(() => {});
            }));
        }

        const events = openEvents.filter(ev => endedIds.indexOf(ev._id) === -1);
        return { success: true, data: await attachGuestCounts(db, events, event.includeArrivedCounts === true) };
      } else if (mode === 'active') {
        // Query yesterday + today to catch night events spanning midnight
        const prev = new Date(dateFilter);
        prev.setDate(prev.getDate() - 1);
        const prevStr = prev.getFullYear() + '-' +
          String(prev.getMonth() + 1).padStart(2, '0') + '-' +
          String(prev.getDate()).padStart(2, '0');
        const _ = db.command;
        eventsQuery = db.collection('events')
          .where({ date: _.gte(prevStr).and(_.lte(dateFilter)) })
          .orderBy('date', 'desc')
          .limit(20);
      } else {
        eventsQuery = db.collection('events').where({ date: dateFilter });
      }

      const evRes = await eventsQuery.get();
      const events = evRes.data || [];
      return { success: true, data: await attachGuestCounts(db, events, event.includeArrivedCounts === true) };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  return { success: false, message: 'Unknown action' };
};