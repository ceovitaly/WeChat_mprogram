const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const generatePassword = (length = 6) => {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
};

exports.main = async (event, context) => {
  const { action, id, name, password, role, phone } = event;

  // GET ALL STAFF
  if (action === 'getAll') {
    try {
      const res = await db.collection('staff').orderBy('createdAt', 'desc').get();
      return { success: true, data: res.data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ADD NEW STAFF
  if (action === 'add') {
    try {
      const finalPassword = password ? password : generatePassword(6);
      await db.collection('staff').add({
        data: {
          name: name.trim(),
          password: finalPassword,
          role: role || 'counter',
          phone: (phone || '').trim(),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { success: true, password: finalPassword };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // UPDATE STAFF
  if (action === 'update') {
    try {
      const updateData = {
        name: name.trim(),
        role: role || 'counter',
        phone: (phone || '').trim(),
        updatedAt: db.serverDate()
      };
      if (password) updateData.password = password;
      await db.collection('staff').doc(id).update({ data: updateData });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // DELETE STAFF
  if (action === 'delete') {
    try {
      await db.collection('staff').doc(id).remove();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // SET DUTY STATUS
  if (action === 'setDutyStatus') {
    try {
      const { staffId, isOnDuty, eventId, eventTitle } = event;
      if (!staffId) return { success: false, message: 'No staffId' };
      const updateData = {
        isOnDuty: !!isOnDuty,
        currentEventId: isOnDuty ? (eventId || '') : '',
        currentEventTitle: isOnDuty ? (eventTitle || '') : '',
        dutyUpdatedAt: db.serverDate()
      };
      if (isOnDuty && eventId) {
        updateData.workedEventIds = db.command.push(eventId);
      }
      await db.collection('staff').doc(staffId).update({ data: updateData });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return { success: false, message: 'Unknown action' };
};