const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { action, id, eventId, status } = event;

  // GET STATS
  if (action === 'getStats') {
    try {
      const [events, staff, promoters] = await Promise.all([
        db.collection('events').count(),
        db.collection('staff').count(),
        db.collection('promoters').where({ status: 'approved' }).count()
      ]);
      return {
        success: true,
        stats: {
          events: events.total,
          staff: staff.total,
          promoters: promoters.total
        }
      };
    } catch (e) {
      return { success: false, error: e };
    }
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
      const [regsRes, eventRes] = await Promise.all([
        db.collection('registrations')
          .where({ eventId: event.eventId })
          .orderBy('promoterName', 'asc')
          .limit(1000)
          .get(),
        db.collection('events').doc(event.eventId).get()
      ]);
      return { success: true, data: regsRes.data, event: eventRes.data };
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

  // UPDATE PROMOTER CODE
  if (action === 'updatePromoterCode') {
    try {
      const { promoCode } = event;
      if (!promoCode) return { success: false, message: 'No promo code provided' };
      const existing = await db.collection('promoters')
        .where({ promoCode })
        .get();
      const taken = existing.data.filter(p => p._id !== id);
      if (taken.length > 0) {
        return { success: false, message: 'Promo code already taken' };
      }
      await db.collection('promoters').doc(id).update({
        data: { promoCode, updatedAt: db.serverDate() }
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // UPDATE PROMOTER (name and/or code)
  if (action === 'updatePromoter') {
    try {
      const { name, promoCode } = event;
      if (!name && !promoCode) return { success: false, message: 'Nothing to update' };
      if (promoCode) {
        const existing = await db.collection('promoters').where({ promoCode }).get();
        const taken = existing.data.filter(p => p._id !== id);
        if (taken.length > 0) return { success: false, message: 'Promo code already taken' };
      }
      const data = { updatedAt: db.serverDate() };
      if (name) data.name = name;
      if (promoCode) data.promoCode = promoCode;
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
      await db.collection('events').doc(targetId).remove();
      return { success: true };
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
        data: { arrivedAt: null }
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // CREATE PROMOTER
  if (action === 'createPromoter') {
    try {
      const { name, promoCode } = event;
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

  // GET EVENT REPORTS
  if (action === 'getEventReports') {
    try {
      const res = await db.collection('event_reports')
        .orderBy('closedAt', 'desc')
        .limit(100)
        .get();
      return { success: true, data: res.data };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // SEED TEST DATA
  if (action === 'seedTestData') {
    try {
      const { eventId } = event;
      if (!eventId) return { success: false, message: 'No eventId' };

      const promoters = [
        { name: 'Aliice', code: 'AISSA' },
        { name: 'Willy', code: 'WILLY' },
        { name: 'Mas', code: 'MAS' },
        { name: 'Vitalii', code: 'VITALII' }
      ];

      const names = [
        'Sophia','Liam','Emma','Noah','Olivia','Ethan','Ava','Mason','Isabella','Logan',
        'Mia','Lucas','Charlotte','Aiden','Amelia','Jackson','Harper','Caden','Evelyn','Grayson',
        'Abigail','Sebastian','Emily','Mateo','Ella','Jack','Madison','Owen','Scarlett','Theodore',
        'Victoria','Henry','Aria','Alexander','Grace','Benjamin','Chloe','Samuel','Penelope','Daniel',
        'Riley','Matthew','Zoey','Elijah','Nora','James','Lily','Michael','Eleanor','David',
        'Hannah','Joseph','Lillian','Carter','Addison','Owen','Aubrey','Luke','Ellie','Jayden',
        'Stella','Dylan','Natalie','Ryan','Zoe','Nathan','Leah','Caleb','Hazel','Isaac',
        'Violet','Hunter','Aurora','Dominic','Savannah','Christian','Audrey','Connor','Brooklyn','Eli',
        'Bella','Jaxon','Claire','Julian','Skylar','Colton','Lucy','Jordan','Paisley','Angel',
        'Everly','Charles','Anna','Aaron','Caroline','Landon','Genesis','Adrian','Aaliyah','Cameron'
      ];

      const now = new Date();
      for (let i = 0; i < names.length; i++) {
        const promoter = promoters[Math.floor(Math.random() * promoters.length)];
        await db.collection('registrations').add({
          data: {
            eventId,
            guestName: names[i],
            promoterName: promoter.name,
            promoCode: promoter.code,
            arrivedAt: null,
            ticketType: 'Free Entry',
            createdAt: now
          }
        });
      }

      return { success: true, count: names.length };
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