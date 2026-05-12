const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// Расшифровка телефона из code (WeChat возвращает зашифрованный код)
async function getPhoneNumber(code) {
  try {
    // В новой версии WeChat нужно использовать cloud.getOpenData
    // Но для phoneCode используется специальный API
    const result = await cloud.getOpenData({
      list: [code]
    });
    
    if (result && result.list && result.list.length > 0) {
      const data = result.list[0];
      if (data.phoneInfo) {
        return data.phoneInfo.phoneNumber;
      }
    }
    
    // Альтернативный способ через decryptMessage
    // Это зависит от конфигурации WeChat
    return null;
  } catch (err) {
    console.error('[getPhoneNumber] error:', err);
    return null;
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { action, phoneCode, promoCode, eventId, ticketType } = event;
  
  try {
    // Действие: получить информацию о пользователе
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
    
    // Действие: получить номер телефона из code
    if (action === 'getPhone') {
      if (!phoneCode) {
        return { success: false, message: 'No phone code provided' };
      }
      
      const phone = await getPhoneNumber(phoneCode);
      
      if (!phone) {
        return { success: false, message: 'Failed to decrypt phone number' };
      }
      
      return { success: true, phone, openid };
    }
    
    // Действие: завершить регистрацию с промокодом
    if (action === 'completeRegistration') {
      if (!promoCode || !eventId || !ticketType) {
        return { success: false, message: 'Missing required fields' };
      }
      
      // Проверяем промокод
      const promoterCheck = await db.collection('promoters')
        .where({ 
          promoCode: promoCode.toUpperCase(),
          status: 'approved'
        })
        .get();
      
      if (promoterCheck.data.length === 0) {
        return { success: false, message: 'Invalid promo code' };
      }
      
      const promoter = promoterCheck.data[0];
      
      // Получаем данные пользователя
      const guests = await db.collection('guests')
        .where({ _openid: openid })
        .get();
      
      if (guests.data.length === 0) {
        return { success: false, message: 'User profile not found' };
      }
      
      const user = guests.data[0];
      
      // Проверяем, не зарегистрирован ли уже
      const existingReg = await db.collection('registrations')
        .where({
          _openid: openid,
          eventId: eventId
        })
        .get();
      
      if (existingReg.data.length > 0) {
        return { success: false, message: 'Already registered' };
      }
      
      // Получаем данные ивента
      const eventDoc = await db.collection('events').doc(eventId).get();
      
      // Создаем регистрацию
      await db.collection('registrations').add({
        data: {
          _openid: openid,
          eventId: eventId,
          eventTitle: eventDoc.data.title,
          eventDate: eventDoc.data.date,
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
      
      return { success: true, message: 'Registration successful' };
    }
    
    // Действие: проверить промокод
    if (action === 'verifyPromoCode') {
      if (!promoCode) {
        return { success: false, message: 'No promo code provided' };
      }
      
      const promoterCheck = await db.collection('promoters')
        .where({ 
          promoCode: promoCode.toUpperCase(),
          status: 'approved'
        })
        .get();
      
      if (promoterCheck.data.length > 0) {
        const promoter = promoterCheck.data[0];
        return { 
          success: true, 
          valid: true,
          promoterId: promoter._id,
          promoterName: promoter.name
        };
      }
      
      return { success: true, valid: false, message: 'Invalid promo code' };
    }
    
    return { success: false, message: 'Unknown action' };
  } catch (err) {
    console.error('[clientAuth] error:', err);
    return { success: false, message: err.message };
  }
};
