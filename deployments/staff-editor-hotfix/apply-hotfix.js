'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function replaceOnce(source, oldText, newText) {
  if (source.split(oldText).length !== 2) {
    throw new Error('Live source does not have the unique expected patch anchor');
  }
  return source.replace(oldText, () => newText);
}

const getPasswordAction = `  // Read one managed credential only after resolving the authenticated admin.
  // Keep credentials out of roster responses and reference caches.
  if (action === 'getPassword') {
    if (caller.role !== 'admin') return { success: false, message: 'Forbidden' };
    if (typeof id !== 'string' || !id.trim()) {
      return { success: false, message: 'Missing staff ID' };
    }
    try {
      const res = await db.collection('staff').where({ _id: id })
        .field({ _id: true, password: true }).limit(1).get();
      const member = (res.data || [])[0];
      if (!member) return { success: false, message: 'Staff member not found' };
      const value = member.password;
      // Never display a hash as if it were the employee's original password.
      if (typeof value !== 'string' || !value || value.startsWith('scrypt$')) {
        return {
          success: true, password: '', passwordAvailable: false,
          code: 'PASSWORD_NOT_RECOVERABLE'
        };
      }
      return { success: true, password: value, passwordAvailable: true };
    } catch (_) {
      return { success: false, message: 'Unable to load password' };
    }
  }

`;

function applyHotfix(source) {
  let patched = replaceOnce(source,
    "const ADMIN_ONLY_ACTIONS = ['add', 'update', 'delete'];",
    "const ADMIN_ONLY_ACTIONS = ['add', 'update', 'delete', 'getPassword'];");
  patched = replaceOnce(patched, '  // GET ALL STAFF\n', getPasswordAction + '  // GET ALL STAFF\n');
  patched = replaceOnce(patched,
    "        const res = await db.collection('staff').orderBy('createdAt', 'desc').get();",
    "        const res = await db.collection('staff').orderBy('createdAt', 'desc')\n" +
    "          .field({ _id: true, name: true, role: true, phone: true, workedEventIds: true,\n" +
    "            createdAt: true, updatedAt: true, lastLogin: true }).get();");
  patched = replaceOnce(patched,
    '      const finalPassword = password ? password : generatePassword(6);',
    "      const finalPassword = password ? String(password) : generatePassword(6);\n" +
    "      if (finalPassword.startsWith('scrypt$')) {\n" +
    "        return { success: false, message: 'Password uses a reserved format' };\n" +
    "      }");
  patched = replaceOnce(patched,
    '      if (password) updateData.password = password;',
    "      if (password) {\n" +
    "        if (String(password).startsWith('scrypt$')) {\n" +
    "          return { success: false, message: 'Password uses a reserved format' };\n" +
    "        }\n" +
    "        updateData.password = String(password);\n" +
    "      }");
  return patched;
}

if (require.main === module) {
  const [sourcePath, destination] = process.argv.slice(2);
  if (!sourcePath || !destination) throw new Error('Usage: node apply-hotfix.js LIVE_INDEX DESTINATION_INDEX');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = applyHotfix(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, result, { mode: 0o600 });
  console.log(JSON.stringify({
    function: 'manageStaff',
    source_sha256: crypto.createHash('sha256').update(source).digest('hex'),
    patched_sha256: crypto.createHash('sha256').update(result).digest('hex'),
    credentials_or_database_records_written: false
  }, null, 2));
}

module.exports = { applyHotfix };
