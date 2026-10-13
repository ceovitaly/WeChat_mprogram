const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require('crypto');
const { hashPassword } = require('./passwords');

const generatePassword = (length = 12) => {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
};

async function getCallerStaff(db) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return null;
  // Same collision guard as manageApplications: an admin who tested a
  // counter's workspace from their own WeChat leaves their openid on that
  // counter's doc, and a bare limit(1) could resolve the caller as the
  // counter. Prefer the admin-role match among a few candidates.
  const res = await db.collection('staff').where({ lastOpenid: openid }).limit(5).get();
  const rows = res.data || [];
  if (rows.length === 0) return null;
  return rows.find(s => s.role === 'admin') || rows[0];
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
        const res = await db.collection('staff')
          .orderBy('createdAt', 'desc')
          .field({
            _id: true,
            name: true,
            role: true,
            phone: true,
            workedEventIds: true,
            createdAt: true,
            updatedAt: true,
            lastLogin: true
          })
          .get();
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
      const finalPassword = password ? String(password) : generatePassword();
      if (finalPassword.length < 10) {
        return { success: false, message: 'Password must be at least 10 characters' };
      }
      const passwordHash = await hashPassword(finalPassword);
      await db.collection('staff').add({
        data: {
          name: name.trim(),
          password: passwordHash,
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
      if (password) {
        if (String(password).length < 10) {
          return { success: false, message: 'Password must be at least 10 characters' };
        }
        updateData.password = await hashPassword(String(password));
        updateData.passwordChangedAt = db.serverDate();
      }
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