// Cross-reference helper: identify staff/promoters hiding inside a guest list by phone number.
// Guest phone numbers come from the guest app's WeChat-verified getPhoneNumber flow (real numbers);
// staff/promoter phone numbers are entered manually by admins, so formatting may differ.
// Normalize conservatively by stripping everything except digits before comparing.

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '')

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
