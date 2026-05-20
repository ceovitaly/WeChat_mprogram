const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { registrationId, arrivedAt } = event;
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