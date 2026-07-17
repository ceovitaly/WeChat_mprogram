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

async function getCallerStaff(db) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return null;
  const res = await db.collection('staff').where({ lastOpenid: openid }).limit(1).get();
  return (res.data && res.data.length > 0) ? res.data[0] : null;
}

exports.main = async (event, context) => {
  const { action, id, name, password, role, phone } = event;

  const caller = await getCallerStaff(db);
  if (!caller) {
    return { success: false, message: 'Unauthorized' };
  }
  // Roster mutations are admin-only — counters may only read (getAll, field-restricted below).
  const ADMIN_ONLY_ACTIONS = ['add', 'update', 'delete'];
  if (caller.role !== 'admin' && ADMIN_ONLY_ACTIONS.includes(action)) {
    return { success: false, message: 'Forbidden' };
  }

  // GET ALL STAFF
  if (action === 'getAll') {
    try {
      if (caller.role === 'admin') {
        const res = await db.collection('staff').orderBy('createdAt', 'desc').get();
        return { success: true, data: res.data };
      }
      // Counter callers (e.g. work.js's phoneMatch.buildInternalRoleMap) only need
      // name/role/phone/workedEventIds — never leak password/lastOpenid to them.
      const res = await db.collection('staff')
        .orderBy('createdAt', 'desc')
        .field({ _id: true, name: true, role: true, phone: true, workedEventIds: true })
        .get();
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

  return { success: false, message: 'Unknown action' };
};