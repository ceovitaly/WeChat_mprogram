const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
  const APPID = 'wxc016d0b6d4c61048';
  const SECRET = 'c36e41c2b72eda5b590daaa5bf9e69ae';
  try {
    const tokenRes = await httpsGet(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`
    );
    if (!tokenRes.access_token) {
      return { error: 'token_failed: ' + JSON.stringify(tokenRes) };
    }
    const phoneRes = await httpsPost(
      `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${tokenRes.access_token}`,
      { code }
    );
    console.log('[getPhoneNumber] phone API result:', JSON.stringify(phoneRes));
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
  const openid = wxContext.OPENID;
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
      
      return { success: true, phone, openid };
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
      const eventDoc = await db.collection('events').doc(eventId).get();
      
      // Create registration
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
