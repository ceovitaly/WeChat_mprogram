const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require('crypto');
const { parseToken } = require('./checkinTokens');
const { switchFreeRegistration } = require('./switchFreeRegistration');
const { eventHasFinished } = require('./freeRegistrationPolicy');

// ─── Door check-in tokens ───────────────────────────────────────────────────
// Validator side of manageApplications' issueCheckinToken — see the design
// notes there. CHECKIN_SECRET must be configured identically in both cloud
// functions; the value is never stored in source control.
const CHECKIN_GRACE_SEC = 2; // display/scan lag allowance on top of the TTL

// Returns { eventId } for a valid unexpired token, or an error code the guest
// app can render: 'bad' (not our format/signature), 'expired'.
function parseCheckinToken(token) {
  return parseToken(token, { graceSec: CHECKIN_GRACE_SEC });
}

// arrivedAt is a "HH:MM" display/sort string in the venue's local time
// (Shanghai, UTC+8) — a counter's device writes the same format from its
// clock, so the scan-generated mark must too. Cloud functions run in UTC.
function shanghaiHHMM() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// Same normalization as the admin app's phone matcher (utils/phoneMatch.js):
// digits only, collapsed to the last 11 so a "+86" prefix on one side and a
// bare local number on the other still match.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 11 ? digits.slice(-11) : digits;
}

// One phone number = one account — BUT the caller's own record always wins.
// Returns every guest doc whose phone normalizes to the same key; the caller
// decides "taken" as: no match belongs to me AND at least one exists. This
// keeps a duplicate doc (same number on two accounts from the old race days,
// or a leftover unnamed record) from locking the real owner out of his own
// number, while still blocking strangers from typing in someone else's.
// Paginated — a single .get() is hard-capped server-side.
async function findPhoneMatches(phone) {
  const key = normalizePhone(phone);
  if (!key) return [];
  const matches = [];
  const BATCH = 1000;
  for (let offset = 0; offset < 50000; offset += BATCH) {
    const res = await db.collection('guests')
      .field({ _openid: true, phone: true })
      .skip(offset)
      .limit(BATCH)
      .get();
    const docs = res.data || [];
    docs.forEach(g => {
      if (normalizePhone(g.phone) === key) matches.push(g);
    });
    if (docs.length < BATCH) break;
  }
  return matches;
}

// True when the phone is claimed by an account OTHER than the caller.
async function phoneTakenByOther(phone, callerOpenid) {
  const matches = await findPhoneMatches(phone);
  if (matches.length === 0) return false;
  return !matches.some(m => m._openid === callerOpenid);
}

async function getPhoneNumber(code, wxContext) {
  try {
    // In a shared environment the default OpenAPI identity is Admin; the
    // phone code belongs to the calling Guest mini program instead.
    const api = wxContext.FROM_APPID
      ? cloud.openapi({ appid: wxContext.FROM_APPID })
      : cloud.openapi;
    const phoneRes = await api.phonenumber.getPhoneNumber({ code });
    const info = phoneRes.phoneInfo || phoneRes.phone_info;
    if (info && (info.phoneNumber || info.purePhoneNumber)) {
      return { phone: info.phoneNumber || info.purePhoneNumber };
    }
    return { error: 'phone_api_failed: ' + (phoneRes.errMsg || phoneRes.errmsg || 'No phone info') };
  } catch (err) {
    return { error: 'exception: ' + (err.message || String(err)) };
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  // This env is owned by the admin appid, so calls arriving from the guest app
  // (cross-appid resource sharing) carry the caller's openid in FROM_OPENID
  // while OPENID comes back empty. FROM_OPENID identifies the actual caller
  // there; OPENID covers same-appid (admin-side) callers.
  const openid = wxContext.FROM_OPENID || wxContext.OPENID;
  const { action, phoneCode, promoCode, eventId, ticketType, venueId, venueName } = event;
  
  try {
    // Action: get user info
    if (action === 'getMe') {
      const guests = await db.collection('guests')
        .where({ _openid: openid })
        .get();
      
      if (guests.data.length > 0) {
        return { success: true, user: guests.data[0] };
      }
      
      const promoters = await db.collection('promoters')
        .where({ promoterId: openid })
        .get();
      
      if (promoters.data.length > 0) {
        return { success: true, user: promoters.data[0] };
      }
      
      return { success: false, message: 'User not found' };
    }
    
    // Action: decrypt phone number from code
    if (action === 'getPhone') {
      if (!phoneCode) {
        return { success: false, message: 'No phone code provided' };
      }

      const result = await getPhoneNumber(phoneCode, wxContext);

      if (!result.phone) {
        return { success: false, message: 'Failed to decrypt phone number', detail: result.error };
      }
      const phone = result.phone;

      // Already registered under a DIFFERENT account? Report it — the client
      // blocks the signup instead of silently creating a second profile. The
      // caller's own record never counts as taken (see phoneTakenByOther).
      if (await phoneTakenByOther(phone, openid)) {
        return { success: true, phone, taken: true };
      }

      return { success: true, phone, openid };
    }

    // Action: manual-entry phone availability check (foreign-number fallback
    // path). The rule is exactly one per phone across WeChat accounts — with
    // the caller's own record always allowed through (sign-in, not a clash).
    if (action === 'checkPhone') {
      const { phone: rawPhone } = event;
      if (!rawPhone) {
        return { success: false, message: 'No phone provided' };
      }
      const taken = await phoneTakenByOther(rawPhone, openid);
      return { success: true, taken };
    }

    // ─── Ticket availability & server-side registration ────────────────────
    // All ticket rules live server-side in ONE place: limits, the timed
    // free→paid switch, and duplicate protection. getTicketAvailability feeds
    // the guest UI (SOLD OUT rows); submitRegistration is the single write
    // path for free registrations (the old direct client write is retired).
    //
    // Night rule shared with everywhere else: a time before noon belongs to
    // the morning AFTER the event's date (a 22:00→04:00 night).
    const nightDeadline = (eventDoc, timeStr) => {
      try {
        const [y, m, d] = String(eventDoc.date || '').split('-').map(Number);
        const [h, min] = String(timeStr).split(':').map(Number);
        if (!y || isNaN(h)) return null;
        const dt = new Date(y, m - 1, d, h, min || 0, 0, 0);
        if (h < 12) dt.setDate(dt.getDate() + 1);
        return dt;
      } catch (e) { return null; }
    };

    const eventEnded = (eventDoc) => {
      if (!eventDoc || eventDoc.isClosed) return true;
      const dl = nightDeadline(eventDoc, eventDoc.endTime);
      return !!(dl && Date.now() > dl.getTime());
    };

    // Free-entry state: closed by the admin's "free until" time OR by the
    // free tickets limit — whichever happens first (user's locked decision).
    const freeEntryState = async (eventDoc) => {
      if (eventDoc.hasFreeEntry === false) return { available: false, reason: 'unavailable' };
      if (eventDoc.freeUntil) {
        const dl = nightDeadline(eventDoc, eventDoc.freeUntil);
        if (dl && Date.now() > dl.getTime()) return { available: false, reason: 'time' };
      }
      const limit = Number(eventDoc.freeTicketsLimit) || 0;
      if (limit > 0) {
        const _ = db.command;
        const cnt = await db.collection('registrations')
          .where({ eventId: eventDoc._id, paid: _.neq(true) }).count();
        if ((cnt.total || 0) >= limit) return { available: false, reason: 'limit' };
      }
      return { available: true, reason: '' };
    };

    if (action === 'getTicketAvailability') {
      if (!eventId) return { success: false, message: 'Missing eventId' };
      const evRes = await db.collection('events').doc(eventId).get().catch(() => null);
      const eventDoc = evRes && evRes.data;
      if (!eventDoc) return { success: false, message: 'Event not found' };
      const free = eventEnded(eventDoc)
        ? { available: false, reason: 'ended' }
        : await freeEntryState(eventDoc);
      // One names-only scan feeds every paid ticket's sold-out flag.
      const soldByTicket = {};
      const soldRes = await db.collection('registrations')
        .where({ eventId, paid: true })
        .field({ ticketId: true })
        .limit(1000)
        .get();
      (soldRes.data || []).forEach(r => {
        if (r.ticketId) soldByTicket[r.ticketId] = (soldByTicket[r.ticketId] || 0) + 1;
      });
      const tickets = [];
      const list = Array.isArray(eventDoc.paidPackages) ? eventDoc.paidPackages : [];
      const tlist = Array.isArray(eventDoc.tickets) ? eventDoc.tickets : [];
      tlist.concat(list).forEach(t => {
        if (!t || !t.id) return;
        const quantity = Number(t.quantity) || 0;
        if (quantity <= 0) return; // unlimited — never sold out
        tickets.push({ id: t.id, soldOut: (soldByTicket[t.id] || 0) >= quantity });
      });
      return { success: true, free, tickets };
    }

    if (action === 'submitRegistration' || action === 'submitRegistrationWithConfirmation') {
      if (!eventId) return { success: false, message: 'Missing eventId' };
      const guestsRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      const guest = (guestsRes.data || [])[0];
      return await switchFreeRegistration(cloud.database({ throwOnNotFound: false }), {
        openid, eventId, guest, validateTarget: freeEntryState,
        requireReplacementConfirmation: action === 'submitRegistrationWithConfirmation' || event.requireReplacementConfirmation === true,
        notifyRegistrationConsequences: event.registrationNoticeVersion === 2,
        replacementConfirmation: event.replacementConfirmation,
        registrationData: {
          guestName: guest && (guest.nickName || guest.name) || '',
          guestAvatar: guest && guest.avatarUrl || '',
          guestPhone: guest && guest.phone || '',
          promoCode: guest && guest.promoCode || '',
          promoterId: guest && guest.promoterId || '',
          promoterName: guest && guest.promoterName || ''
        }
      });
    }

    // Legacy promo-code entry uses exactly the same atomic free-entry policy.
    if (action === 'completeRegistration') {
      if (!promoCode || !eventId || !ticketType) {
        return { success: false, message: 'Missing required fields' };
      }
      const promoterCheck = await db.collection('promoters')
        .where({ promoCode: promoCode.toUpperCase().trim() }).get();
      const promoter = (promoterCheck.data || [])[0];
      if (!promoter || promoter.status === 'suspended' || promoter.status === 'revoked') {
        return { success: false, message: 'Invalid promo code' };
      }
      const guestsRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      const guest = (guestsRes.data || [])[0];
      return await switchFreeRegistration(cloud.database({ throwOnNotFound: false }), {
        openid, eventId, guest, validateTarget: freeEntryState,
        requireReplacementConfirmation: action === 'submitRegistrationWithConfirmation' || event.requireReplacementConfirmation === true,
        notifyRegistrationConsequences: event.registrationNoticeVersion === 2,
        replacementConfirmation: event.replacementConfirmation,
        registrationData: {
          guestName: guest && (guest.nickName || guest.name) || '',
          guestAvatar: guest && guest.avatarUrl || '',
          guestPhone: guest && guest.phone || '',
          promoCode: promoCode.toUpperCase().trim(),
          promoterId: promoter._id,
          promoterName: promoter.name
        }
      });
    }

    if (action === 'verifyPromoCode') {
      if (!promoCode) {
        return { success: false, message: 'No promo code provided' };
      }

      const code = promoCode.toUpperCase().trim();
      const promoterCheck = await db.collection('promoters')
        .where({ promoCode: code })
        .get();

      if (promoterCheck.data.length === 0) {
        return { success: true, valid: false, message: 'Invalid promo code' };
      }

      const promoter = promoterCheck.data[0];
      if (promoter.status === 'suspended' || promoter.status === 'revoked') {
        return { success: true, valid: false, message: 'This promo code has been deactivated' };
      }

      return {
        success: true,
        valid: true,
        promoterId: promoter._id,
        promoterName: promoter.name
      };
    }
    
    // ─── Door check-in scan (anti-fraud) ────────────────────────────────────
    // Two steps so the guest sees WHAT they're confirming before anything is
    // written: inspect returns the context, confirm writes the scan AND the
    // arrival mark. The registration is matched by the caller's openid — a
    // phone that isn't the registered account's cannot confirm someone else's
    // spot.
    if (action === 'inspectCheckinToken') {
      const parsed = parseCheckinToken(event.token);
      if (parsed.error) return { success: true, invalid: true, reason: parsed.error };
      const regRes = await db.collection('registrations')
        .where({ eventId: parsed.eventId, _openid: openid })
        .limit(1)
        .get();
      if (!regRes.data || regRes.data.length === 0) {
        return { success: true, invalid: true, reason: 'not_registered' };
      }
      const reg = regRes.data[0];
      return {
        success: true,
        invalid: false,
        eventTitle: reg.eventTitle || '',
        guestName: reg.guestName || '',
        alreadyScanned: !!reg.scannedAt,
        alreadyArrived: !!reg.arrivedAt
      };
    }

    if (action === 'confirmArrival') {
      const parsed = parseCheckinToken(event.token);
      if (parsed.error) return { success: true, invalid: true, reason: parsed.error };
      const regRes = await db.collection('registrations')
        .where({ eventId: parsed.eventId, _openid: openid })
        .limit(1)
        .get();
      if (!regRes.data || regRes.data.length === 0) {
        return { success: true, invalid: true, reason: 'not_registered' };
      }
      const reg = regRes.data[0];
      // Repeat scan (or the row is already marked by a counter tap): reply
      // with an explicit "already" flag so the guest gets told instead of a
      // replayed success. Marks stay idempotent — the first scan/mark keeps
      // its original arrival and scan timestamps.
      const already = !!(reg.scannedAt || reg.arrivedAt);
      const patch = {};
      if (!reg.scannedAt) patch.scannedAt = db.serverDate();
      if (!reg.arrivedAt) {
        patch.arrivedAt = shanghaiHHMM();
        patch.checkedInAt = db.serverDate();
      }
      if (Object.keys(patch).length > 0) {
        await db.runTransaction(async tx => {
          const current = (await tx.collection('registrations').doc(reg._id).get()).data;
          if (!current || current._openid !== openid || current.eventId !== parsed.eventId) throw new Error('Registration changed');
          if (current.scannedAt) return;
          const ev = (await tx.collection('events').doc(parsed.eventId).get()).data;
          const venue = ev && ev.venueId ? (await tx.collection('venues').doc(ev.venueId).get()).data : null;
          const session = venue && venue.counterSession;
          const effectivePatch = { scannedAt: db.serverDate() };
          if (!current.arrivedAt) {
            effectivePatch.arrivedAt = patch.arrivedAt;
            effectivePatch.checkedInAt = db.serverDate();
          }
          await tx.collection('registrations').doc(reg._id).update({ data: effectivePatch });
          const entryId = crypto.createHash('sha256').update('guest-scan:' + reg._id + ':'
            + String(current.updatedAt && current.updatedAt.$date || current.updatedAt || current.createdAt || '')).digest('hex');
          await tx.collection('counter_session_history').doc(entryId).set({ data: {
            type: current.arrivedAt ? 'QR_SCAN' : 'QR_CHECKIN', at: db.serverDate(), venueId: ev && ev.venueId || '',
            venueName: ev && ev.venueName || '', eventId: parsed.eventId,
            eventTitle: ev && ev.title || current.eventTitle || '', eventDate: ev && ev.date || '',
            actorId: crypto.createHash('sha256').update(openid).digest('hex'),
            actorName: String(current.guestName || '').slice(0, 160), actorRole: 'guest',
            targetId: reg._id, targetName: String(current.guestName || '').slice(0, 160),
            sessionId: session && session.eventId === parsed.eventId && session.expiresAt > Date.now()
              ? session.idHash : '', result: 'success', details: { method: 'guest_qr' }
          } });
        });
      }
      // Registration changes handle the current entry; scanning never rechecks history.
      const supersededEvents = [];
      return { success: true, already, guestName: reg.guestName || '', supersededEvents };
    }

    // Action: event feed. A direct client query is hard-capped at 20 docs by
    // WeChat no matter what .limit() says — with a busy calendar that cap
    // silently dropped the NEWEST events (ascending order keeps the oldest
    // 20), so today's event never reached the guest's feed. Server-side the
    // ceiling is 1000. The client scopes the call to a date WINDOW
    // (dateFrom/dateTo) instead of fetching all history, so the ceiling is
    // never approached. Returns display-safe fields only — no `description`
    // (heavy HTML the feed cards never render; event-detail loads its own
    // doc). Server-owned completion keeps stored status and registration aligned.
    if (action === 'getEvents') {
      try {
        const { dateFrom, dateTo } = event;
        const _ = db.command;
        const where = { status: 'active', isClosed: _.neq(true), deleting: _.neq(true) };
        if (dateFrom && dateTo) where.date = _.gte(dateFrom).and(_.lte(dateTo));
        else if (dateFrom) where.date = _.gte(dateFrom);
        else if (dateTo) where.date = _.lte(dateTo);
        const res = await db.collection('events')
          .where(where)
          .orderBy('date', 'asc')
          .limit(1000)
          .get();
        // The feed and registration share one server-side Shanghai deadline.
        // Persist completion here too: it must not depend on opening Admin.
        // Leave isClosed/reports/photos to the existing archival workflow.
        const nowMs = Date.now();
        const activeEvents = [];
        const rows = res.data || [];
        for (let offset = 0; offset < rows.length; offset += 10) {
          const batch = await Promise.all(rows.slice(offset, offset + 10).map(async ev => {
            if (!eventHasFinished(ev, nowMs)) return ev;
            // Do not close an event that an admin concurrently rescheduled.
            const expected = { _id: ev._id, status: 'active', isClosed: _.neq(true), deleting: _.neq(true) };
            ['date', 'startTime', 'endTime'].forEach(key => {
              if (ev[key] !== undefined) expected[key] = ev[key];
            });
            const changed = await db.collection('events').where(expected).update({
              data: { status: 'closed', updatedAt: db.serverDate() }
            });
            if (changed.stats && changed.stats.updated === 0) {
              const fresh = (await db.collection('events').doc(ev._id).get()).data;
              if (fresh && fresh.status === 'active' && fresh.isClosed !== true &&
                  fresh.deleting !== true && !eventHasFinished(fresh, Date.now())) return fresh;
            }
            return null;
          }));
          activeEvents.push(...batch.filter(Boolean));
        }
        const SAFE_FIELDS = ['_id', 'title', 'date', 'startTime', 'endTime',
          'venueName', 'venueId', 'isClosed', 'status', 'partyCapacity',
          'afterPartyCapacity', 'lateAfterPartyCapacity', 'isFree', 'isPaid',
          'hasFreeEntry', 'hasPaidPackages', 'eventsOnly', 'coverImage', 'images', 'promoImages'];
        const data = activeEvents.map(e => {
          const safe = {};
          SAFE_FIELDS.forEach(k => { if (e[k] !== undefined) safe[k] = e[k]; });
          // Closed events have their photos PURGED from storage (see
          // manageApplications purgeEventImages) — serving dead file ids
          // only produces failed image loads in the feed, so they are
          // stripped here.
          if (e.isClosed) {
            safe.coverImage = '';
            safe.images = [];
            safe.promoImages = [];
          }
          return safe;
        });
        return { success: true, data };
      } catch (e) {
        return { success: false, message: e.message };
      }
    }

    // Action: full event document for the WEB version's detail page. The
    // mini-program reads the events collection directly (client ACL); the
    // web app has no database access, so the same public data is served
    // here — event docs carry no secrets (venue door passwords live in the
    // venues collection and go through getVenue's safe-fields filter).
    if (action === 'getEventDetail') {
      const id = event.eventId;
      if (!id) return { success: false, message: 'Missing eventId' };
      try {
        const res = await db.collection('events').doc(id).get();
        return { success: true, event: res.data };
      } catch (e) {
        return { success: false, message: 'Event not found' };
      }
    }

    // Action: venue lookup for the event page. The venues collection is
    // locked to no-client-access (docs also carry the venue door password),
    // so guests fetch venue info through this server-side read, which
    // returns only the safe display fields. venueId wins when present;
    // the name fallback orders by updatedAt desc so the newest-edited doc
    // wins when duplicate venue names exist (docs without updatedAt sort
    // last, i.e. behind any doc the admin has actually edited).
    if (action === 'getVenue') {
      let venueDoc = null;
      if (venueId) {
        const res = await db.collection('venues').doc(venueId).get();
        venueDoc = res.data;
      } else if (venueName) {
        const res = await db.collection('venues')
          .where({ name: venueName })
          .orderBy('updatedAt', 'desc')
          .limit(1)
          .get();
        if (res.data && res.data.length > 0) venueDoc = res.data[0];
      }

      if (!venueDoc) {
        return { success: false };
      }

      // Safe fields ONLY — never the password or anything else.
      return {
        success: true,
        venue: {
          name: venueDoc.name || '',
          address: venueDoc.address || '',
          latitude: venueDoc.latitude || null,
          longitude: venueDoc.longitude || null,
          coordinates: venueDoc.coordinates || null
        }
      };
    }

    // VENUE GALLERY — guest-facing. Tiles with venue logos; the photos of a
    // venue (galleryImages) are managed from the admin panel. Only the
    // public display fields travel to the guest app — never door passwords.
    if (action === 'getVenueGalleries') {
      const res = await db.collection('venues')
        .field({ name: true, logoImage: true, galleryImages: true })
        .limit(100)
        .get();
      const data = (res.data || []).map(v => ({
        _id: v._id,
        name: v.name || '',
        logo: v.logoImage || '',
        photos: Array.isArray(v.galleryImages) ? v.galleryImages : []
      })).filter(v => v.photos && v.photos.length > 0);
      return { success: true, data };
    }

    if (action === 'resolveImages') {
      const fileList = event.fileList || [];
      if (fileList.length === 0) return { urlMap: {} };
      const urlMap = {};
      // getTempFileURL accepts max 50 file IDs per call — batch them.
      for (let i = 0; i < fileList.length; i += 50) {
        const batch = fileList.slice(i, i + 50);
        const tempRes = await cloud.getTempFileURL({ fileList: batch });
        tempRes.fileList.forEach(f => {
          if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL;
        });
      }
      return { urlMap };
    }

    return { success: false, message: 'Unknown action' };
  } catch (err) {
    console.error('[clientAuth] error:', err);
    return { success: false, message: err.message };
  }
};
