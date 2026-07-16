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

exports.main = async (event) => {
  const { registrationId, arrivedAt } = event;
  const caller = await getCallerStaff(db);
  if (!caller) {
    return { success: false, message: 'Unauthorized' };
  }
  try {
    await db.collection('registrations').doc(registrationId).update({
      data: {
        arrivedAt,
        checkedInAt: db.serverDate()
      }
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
};