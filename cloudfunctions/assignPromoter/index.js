const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { token, openid } = event;

  try {
    if (!token || !token.startsWith('promo_')) {
      return { success: false, message: 'Invalid QR code' };
    }

    // Используем openid переданный из клиента
    const userOpenid = openid;
    if (!userOpenid) {
      return { success: false, message: 'No openid provided' };
    }

    const guestRes = await db.collection('guests')
      .where({ _openid: userOpenid })
      .get();

    if (guestRes.data.length === 0) {
      return { success: false, message: 'Profile not found. Please set up your profile first.' };
    }

    const guest = guestRes.data[0];

    const existingPromoter = await db.collection('promoters')
      .where({ promoterId: userOpenid })
      .get();

    if (existingPromoter.data.length > 0) {
      return { success: false, message: 'You are already a promoter' };
    }

    await db.collection('promoters').add({
      data: {
        name: guest.nickName || 'Promoter',
        phone: guest.phone || '',
        avatarUrl: guest.avatarUrl || '',
        promoterId: userOpenid,
        status: 'approved',
        totalGuests: 0,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    await db.collection('guests').doc(guest._id).remove();

    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
};