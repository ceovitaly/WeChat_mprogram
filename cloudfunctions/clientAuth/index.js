const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { parseToken } = require('./checkinTokens');
const { loadWechatConfig } = require('./wechatConfig');

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

// ─── One guest — one simultaneous venue ─────────────────────────────────────
// Same rule as checkInGuest (separate deploy — helpers duplicated verbatim,
// keep in sync). Absolute-ms window of an event: date "YYYY-MM-DD" plus
// startTime/endTime "HH:MM"; Date.UTC on both sides keeps the comparison
// timezone-independent, and an endTime earlier than startTime means the party
// crosses midnight (+1 day).
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

function windowsOverlap(a, b) {
  return !!(a && b && a.start < b.end && b.start < a.end);
}

// arrivedAt is a "HH:MM" display/sort string in the venue's local time
// (Shanghai, UTC+8) — a counter's device writes the same format from its
// clock, so the scan-generated mark must too. Cloud functions run in UTC.
function shanghaiHHMM() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// Clears the guest's arrival marks on events whose window overlaps eventId's
// (they physically moved venues — last venue wins). Marks on non-overlapping
// (sequential) events are kept. Mirrors the logic in checkInGuest; returns
// the superseded events' titles for optional caller feedback.
async function supersedeOverlappingMarks(openid, eventId, excludeRegId) {
  const thisEventRes = await db.collection('events').doc(eventId).get().catch(() => null);
  const thisWindow = eventWindowMs(thisEventRes && thisEventRes.data);
  if (!thisWindow) return [];
  const othersRes = await db.collection('registrations')
    .where({ _openid: openid })
    .limit(1000)
    .get();
  // Same-eventId excluded: a legacy duplicate registration of the SAME event
  // must never clear its own event's mark.
  const marked = (othersRes.data || []).filter(r =>
    r.arrivedAt && r._id !== excludeRegId && r.eventId !== eventId
  );
  const eventIds = Array.from(new Set(marked.map(r => r.eventId)));
  const eventDocs = {};
  await Promise.all(eventIds.map(id =>
    db.collection('events').doc(id).get()
      .then(res => { eventDocs[id] = res.data; })
      .catch(() => {})
  ));
  const toClear = marked.filter(r => windowsOverlap(thisWindow, eventWindowMs(eventDocs[r.eventId])));
  await Promise.all(toClear.map(r =>
    db.collection('registrations').doc(r._id).update({
      data: { arrivedAt: null, checkedInAt: null }
    })
  ));
  return toClear.map(r => (eventDocs[r.eventId] && eventDocs[r.eventId].title) || r.eventId);
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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    require('https').get(url, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = require('https').request(url, options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getPhoneNumber(code) {
  try {
    const { appid, secret } = loadWechatConfig();
    const tokenRes = await httpsGet(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`
    );
    if (!tokenRes.access_token) {
      return { error: 'token_failed: ' + JSON.stringify(tokenRes) };
    }
    const phoneRes = await httpsPost(
      `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${tokenRes.access_token}`,
      { code }
    );
    const info = phoneRes.phone_info;
    if (info && (info.phoneNumber || info.purePhoneNumber)) {
      return { phone: info.phoneNumber || info.purePhoneNumber };
    }
    return { error: 'phone_api_failed: ' + JSON.stringify(phoneRes) };
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

      const result = await getPhoneNumber(phoneCode);

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

    if (action === 'submitRegistration') {
      if (!eventId) return { success: false, message: 'Missing eventId' };
      const evRes = await db.collection('events').doc(eventId).get().catch(() => null);
      const eventDoc = evRes && evRes.data;
      if (!eventDoc) return { success: false, message: 'Event not found' };
      if (eventEnded(eventDoc)) {
        return { success: true, code: 'EVENT_OVER' };
      }
      // One registration per (event, guest) — the deterministic id enforces it.
      const regId = eventId + '_' + openid;
      const existing = await db.collection('registrations').doc(regId).get().catch(() => null);
      if (existing && existing.data) {
        return { success: true, code: 'ALREADY_REGISTERED' };
      }
      const free = await freeEntryState(eventDoc);
      if (!free.available) {
        return { success: true, code: free.reason === 'time' ? 'FREE_CLOSED_BY_TIME' : 'FREE_SOLD_OUT' };
      }
      const guestsRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      const guest = (guestsRes.data && guestsRes.data[0]) || {};
      try {
        await db.collection('registrations').add({
          data: {
            _id: regId,
            _openid: openid,
            eventId,
            eventTitle: eventDoc.title || '',
            eventDate: eventDoc.date || '',
            guestName: guest.nickName || guest.name || '',
            guestAvatar: guest.avatarUrl || '',
            guestPhone: guest.phone || '',
            promoCode: guest.promoCode || '',
            promoterId: guest.promoterId || '',
            promoterName: guest.promoterName || '',
            ticketType: 'Free Entry',
            status: 'confirmed',
            createdAt: db.serverDate()
          }
        });
      } catch (addErr) {
        const msg = String((addErr && (addErr.errMsg || addErr.message)) || addErr);
        if (/duplicat|already exist/i.test(msg)) return { success: true, code: 'ALREADY_REGISTERED' };
        throw addErr;
      }
      // Instant stored counter (read side: attachGuestCounts).
      await db.collection('events').doc(eventId).update({
        data: { guestCount: db.command.inc(1), guestCountSyncedAt: db.serverDate() }
      }).catch(() => {});
      return { success: true };
    }
    
    // Action: complete registration with promo code
    if (action === 'completeRegistration') {
      if (!promoCode || !eventId || !ticketType) {
        return { success: false, message: 'Missing required fields' };
      }
      
      // Verify promo code
      const promoterCheck = await db.collection('promoters')
        .where({ promoCode: promoCode.toUpperCase().trim() })
        .get();

      if (promoterCheck.data.length === 0 || promoterCheck.data[0].status === 'suspended' || promoterCheck.data[0].status === 'revoked') {
        return { success: false, message: 'Invalid promo code' };
      }
      
      const promoter = promoterCheck.data[0];
      
      // Fetch user data
      const guests = await db.collection('guests')
        .where({ _openid: openid })
        .get();
      
      if (guests.data.length === 0) {
        return { success: false, message: 'User profile not found' };
      }
      
      const user = guests.data[0];
      
      // Check for existing registration
      const existingReg = await db.collection('registrations')
        .where({
          _openid: openid,
          eventId: eventId
        })
        .get();
      
      if (existingReg.data.length > 0) {
        return { success: false, message: 'Already registered' };
      }
      
      // Fetch event data
      const evRes = await db.collection('events').doc(eventId).get();
      const eventDoc = evRes.data;
      // Same gates as submitRegistration: this legacy path must not be a
      // bypass around the limits / timed free→paid switch / event end.
      if (eventEnded(eventDoc)) {
        return { success: true, code: 'EVENT_OVER' };
      }
      const freeState = await freeEntryState(eventDoc);
      if (!freeState.available) {
        return { success: true, code: freeState.reason === 'time' ? 'FREE_CLOSED_BY_TIME' : 'FREE_SOLD_OUT' };
      }

      // Create registration
      await db.collection('registrations').add({
        data: {
          _openid: openid,
          eventId: eventId,
          eventTitle: eventDoc.title || '',
          eventDate: eventDoc.date || '',
          guestName: user.nickName || user.name || '',
          guestAvatar: user.avatarUrl || '',
          guestPhone: user.phone || '',
          promoterId: promoter._id,
          promoterName: promoter.name,
          ticketType: ticketType,
          status: 'confirmed',
          createdAt: db.serverDate()
        }
      });

      // New registration → bump the event's stored guest counter (read side:
      // attachGuestCounts in manageApplications).
      await db.collection('events').doc(eventId).update({
        data: { guestCount: db.command.inc(1), guestCountSyncedAt: db.serverDate() }
      }).catch(() => {});
      
      return { success: true, message: 'Registration successful' };
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
      // its times — and the overlap rule still runs below (a scan at THIS
      // venue keeps winning over overlapping events).
      const already = !!(reg.scannedAt || reg.arrivedAt);
      const patch = {};
      if (!reg.scannedAt) patch.scannedAt = db.serverDate();
      if (!reg.arrivedAt) {
        patch.arrivedAt = shanghaiHHMM();
        patch.checkedInAt = db.serverDate();
      }
      if (Object.keys(patch).length > 0) {
        await db.collection('registrations').doc(reg._id).update({ data: patch });
      }
      // Same one-guest-one-simultaneous-venue rule as the counter tap: a scan
      // at this venue supersedes the guest's marks on overlapping events.
      const supersededEvents = await supersedeOverlappingMarks(openid, parsed.eventId, reg._id);
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
    // doc). The client's hasEnded() filter still decides visibility.
    if (action === 'getEvents') {
      try {
        const { dateFrom, dateTo } = event;
        const _ = db.command;
        const where = {};
        if (dateFrom && dateTo) where.date = _.gte(dateFrom).and(_.lte(dateTo));
        else if (dateFrom) where.date = _.gte(dateFrom);
        else if (dateTo) where.date = _.lte(dateTo);
        const res = await db.collection('events')
          .where(where)
          .orderBy('date', 'asc')
          .limit(1000)
          .get();
        const SAFE_FIELDS = ['_id', 'title', 'date', 'startTime', 'endTime',
          'venueName', 'venueId', 'isClosed', 'status', 'partyCapacity',
          'afterPartyCapacity', 'lateAfterPartyCapacity', 'isFree', 'isPaid',
          'hasFreeEntry', 'hasPaidPackages', 'eventsOnly', 'coverImage', 'images', 'promoImages'];
        const data = (res.data || []).map(e => {
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
