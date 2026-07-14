// Cross-reference helper: identify staff/promoters hiding inside a guest list by phone number.
// Guest phone numbers come from the guest app's WeChat-verified getPhoneNumber flow (real numbers);
// staff/promoter phone numbers are entered manually by admins, so formatting may differ.
// Normalize conservatively by stripping everything except digits before comparing.

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '')

// Builds a normalized-phone -> { type: 'staff' | 'promoter', label } lookup from
// the staff and promoter lists. If the same phone appears in both, staff wins.
const buildInternalRoleMap = (staffList, promoterList) => {
  const map = {}
  ;(promoterList || []).forEach(p => {
    const key = normalizePhone(p.phone)
    if (key) map[key] = { type: 'promoter', label: p.name || 'Promoter' }
  })
  ;(staffList || []).forEach(s => {
    const key = normalizePhone(s.phone)
    if (key) map[key] = { type: 'staff', label: s.name || (s.role === 'admin' ? 'Admin' : 'Counter') }
  })
  return map
}

// Returns a shallow copy of item annotated with internalRole/internalLabel based on a
// phone match against roleMap. Never mutates item or its phone/other real fields.
const annotateInternalRole = (item, roleMap) => {
  const key = normalizePhone(item.phone)
  const match = key ? roleMap[key] : null
  return Object.assign({}, item, {
    internalRole: match ? match.type : null,
    internalLabel: match ? match.label : ''
  })
}

module.exports = {
  normalizePhone,
  buildInternalRoleMap,
  annotateInternalRole
}
