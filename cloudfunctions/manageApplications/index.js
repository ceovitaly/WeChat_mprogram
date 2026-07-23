const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function getCallerStaff(db) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return null;
  const res = await db.collection('staff').where({ lastOpenid: openid }).limit(1).get();
  return (res.data && res.data.length > 0) ? res.data[0] : null;
}

exports.main = async (event, context) => {
  const { action, id, eventId, status } = event;

  const caller = await getCallerStaff(db);
  if (!caller) {
    return { success: false, message: 'Unauthorized' };
  }
  const COUNTER_ALLOWED_ACTIONS = ['getRegistrations', 'getPromoters', 'markAttendance', 'uncheckGuest', 'verifyVenuePassword'];
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

  // GET ALL GUESTS (from guests collection)
  if (action === 'getAllGuests') {
    try {
      const res = await db.collection('guests')
        .orderBy('createdAt', 'desc')
        .limit(1000)
        .get()

      return {
        success: true,
        data: res.data,
        total: res.data.length
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // GET REGISTRATIONS
  if (action === 'getRegistrations') {
    try {
      const [regsRes, eventRes, dutyStaffRes] = await Promise.all([
        db.collection('registrations')
          .where({ eventId: event.eventId })
          .orderBy('promoterName', 'asc')
          .limit(1000)
          .get(),
        db.collection('events').doc(event.eventId).get(),
        // Staff who worked this event (workedEventIds is the sole source of truth) —
        // returned server-side so the client never reads the staff collection directly.
        db.collection('staff')
          .where({ workedEventIds: event.eventId })
          .field({ _id: true, name: true })
          .get()
          .catch(() => ({ data: [] }))
      ]);

      const regs = regsRes.data || [];

      // Attach phone from the guests collection (keyed by _openid) so the admin
      // page can badge registrations that are actually staff/promoters testing
      // the guest flow. Never written back — read-only annotation.
      // Chunked: an unbounded .get() silently caps at 100 docs server-side, which
      // truncated the phone map for events with >100 unique guests.
      const openids = [...new Set(regs.map(r => r._openid).filter(Boolean))];
      const phoneByOpenid = {};
      if (openids.length > 0) {
        const BATCH = 500;
        const batches = [];
        for (let i = 0; i < openids.length; i += BATCH) {
          batches.push(openids.slice(i, i + BATCH));
        }
        const results = await Promise.all(batches.map(batch =>
          db.collection('guests')
            .where({ _openid: db.command.in(batch) })
            .field({ _openid: true, phone: true })
            .limit(1000)
            .get()
        ));
        results.forEach(guestsRes => {
          (guestsRes.data || []).forEach(g => { phoneByOpenid[g._openid] = g.phone || ''; });
        });
      }
      const data = regs.map(r => Object.assign({}, r, { phone: phoneByOpenid[r._openid] || '' }));

      return { success: true, data, event: eventRes.data, dutyStaff: dutyStaffRes.data || [] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // GET PROMOTERS
  if (action === 'getPromoters') {
    try {
      const res = await db.collection('promoters').orderBy('createdAt', 'desc').get();
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
      const data = { updatedAt: db.serverDate() };
      if (name) data.name = name;
      if (promoCode) data.promoCode = promoCode;
      if (phone !== undefined) data.phone = phone;
      await db.collection('promoters').doc(id).update({ data });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // DELETE PROMOTER
  if (action === 'deletePromoter') {
    try {
      if (!id) return { success: false, message: 'No ID provided' };
      await db.collection('promoters').doc(id).remove();
      return { success: true };
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
    try {
      const targetId = eventId || id;
      if (!targetId) return { success: false, message: 'No ID provided' };

      // Cascade: an event's registrations are meaningless once the event itself
      // is gone — otherwise guests keep a ticket in "My Tickets" for an event
      // that no longer exists anywhere in the app.
      const regsRes = await db.collection('registrations')
        .where({ eventId: targetId })
        .field({ _id: true })
        .limit(1000)
        .get();
      await Promise.all(
        (regsRes.data || []).map(r => db.collection('registrations').doc(r._id).remove())
      );

      await db.collection('events').doc(targetId).remove();
      return { success: true, removedRegistrations: (regsRes.data || []).length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // UNCHECK GUEST
  if (action === 'uncheckGuest') {
    try {
      const { registrationId } = event;
      if (!registrationId) return { success: false, message: 'No registrationId' };
      await db.collection('registrations').doc(registrationId).update({
        data: { arrivedAt: null, checkedInAt: null }
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
      const res = await db.collection('venues').get();
      return { success: true, data: res.data || [] };
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

  // CLOSE EVENT — mark event as closed
  if (action === 'closeEvent') {
    try {
      const { eventId, closedBy } = event;
      if (!eventId) return { success: false, message: 'No eventId' };
      await db.collection('events').doc(eventId).update({
        data: {
          status: 'closed',
          isClosed: true,
          closedAt: db.serverDate(),
          closedBy: closedBy || 'Unknown'
        }
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  if (action === 'updateGuestPromoter') {
    try {
      const { guestId, promoterName } = event;
      if (!guestId) return { success: false, message: 'No guestId' };
      await db.collection('guests').doc(guestId).update({
        data: { promoterName: promoterName || '' }
      });
      return { success: true };
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
        db.collection('registrations').count()
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

      const withCounts = await Promise.all(events.map(async ev => {
        try {
          const cnt = await db.collection('registrations').where({ eventId: ev._id }).count();
          return Object.assign({}, ev, { guestCount: cnt.total || 0 });
        } catch (e) {
          return Object.assign({}, ev, { guestCount: 0 });
        }
      }));

      return { success: true, data: withCounts };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  return { success: false, message: 'Unknown action' };
};