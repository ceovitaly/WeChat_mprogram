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

  // GET ALL GUESTS (from registrations, paginated)
  if (action === 'getAllGuests') {
    try {
      const skip = event.skip || 0
      const limit = event.limit || 50

      const [countRes, dataRes] = await Promise.all([
        db.collection('registrations').count(),
        db.collection('registrations')
          .orderBy('createdAt', 'desc')
          .skip(skip)
          .limit(limit)
          .get()
      ])

      return {
        success: true,
        data: dataRes.data,
        total: countRes.total
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // GET REGISTRATIONS
  if (action === 'getRegistrations') {
    try {
      const res = await db.collection('registrations')
        .where({ eventId: event.eventId })
        .orderBy('promoterName', 'asc')
        .limit(1000)
        .get();
      return { success: true, data: res.data };
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

  return { success: false, message: 'Unknown action' };
};