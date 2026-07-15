// Cross-reference helper: identify staff/promoters hiding inside a guest list by phone number.
// Guest phone numbers come from the guest app's WeChat-verified getPhoneNumber flow (real numbers);
// staff/promoter phone numbers are entered manually by admins, so formatting may differ.
// Normalize by stripping everything except digits, then collapsing to the last 11 digits so a
// country-code prefix on the guest-app side (e.g. "+86") doesn't prevent a match against an
// admin-entered plain local number.

// Chinese mobile numbers are always 11 digits. Guest-app phones may carry a
// country-code prefix (WeChat's getPhoneNumber prefers the `phoneNumber` field,
// e.g. "+8613812345678") while admin-entered staff/promoter phones are typically
// the plain local 11-digit form ("13812345678") — collapsing to the last 11
// digits reconciles both regardless of prefix formatting (+86/0086/86/none).
const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length > 11 ? digits.slice(-11) : digits
}

// Builds a normalized-phone -> { type: 'staff' | 'promoter', label, id, eventIds } lookup
// from the staff and promoter lists. If the same phone appears in both, staff wins.
// eventIds is the raw event-tracking array for that person (workedEventIds for staff,
// attendedEventIds for promoters) — used by annotateAttendance below.
const buildInternalRoleMap = (staffList, promoterList) => {
  const map = {}
  ;(promoterList || []).forEach(p => {
    const key = normalizePhone(p.phone)
    if (key) map[key] = { type: 'promoter', label: p.name || 'Promoter', id: p._id, eventIds: p.attendedEventIds || [] }
  })
  ;(staffList || []).forEach(s => {
    const key = normalizePhone(s.phone)
    if (key) map[key] = { type: 'staff', label: s.name || (s.role === 'admin' ? 'Admin' : 'Counter'), id: s._id, eventIds: s.workedEventIds || [] }
  })
  return map
}

// Returns a shallow copy of item annotated with internalRole/internalLabel/internalId based
// on a phone match against roleMap. Never mutates item or its phone/other real fields.
const annotateInternalRole = (item, roleMap) => {
  const key = normalizePhone(item.phone)
  const match = key ? roleMap[key] : null
  return Object.assign({}, item, {
    internalRole: match ? match.type : null,
    internalLabel: match ? match.label : '',
    internalId: match ? match.id : ''
  })
}

// Like annotateInternalRole, but also computes attendancePresent — whether the matched
// staff/promoter's own event-tracking array already includes eventId. Used by the counter's
// guest-list attendance-marking button.
const annotateAttendance = (item, roleMap, eventId) => {
  const key = normalizePhone(item.phone)
  const match = key ? roleMap[key] : null
  const present = !!(match && eventId && match.eventIds.includes(eventId))
  return Object.assign({}, item, {
    internalRole: match ? match.type : null,
    internalLabel: match ? match.label : '',
    internalId: match ? match.id : '',
    attendancePresent: present
  })
}

module.exports = {
  normalizePhone,
  buildInternalRoleMap,
  annotateInternalRole,
  annotateAttendance
}
