const formatDate = (dateObj) => {
  if (!dateObj) return ''
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj)
  const day = String(d.getDate()).padStart(2, '0')
  const month = d.toLocaleString('en', { month: 'short' })
  const year = d.getFullYear()
  return `${day} ${month} ${year}`
}

const formatTime = (dateObj) => {
  if (!dateObj) return ''
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

const formatDateTime = (dateObj) => {
  if (!dateObj) return ''
  return `${formatDate(dateObj)} · ${formatTime(dateObj)}`
}

const formatPrice = (amount) => {
  if (amount === undefined || amount === null) return '¥0'
  return `¥${Math.round(amount).toLocaleString()}`
}

const formatPhone = (phone) => {
  if (!phone) return ''
  return phone.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3')
}

const getInitials = (name) => {
  if (!name) return '?'
  const parts = name.trim().split(' ')
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const formatGuestCount = (arrived, total) => {
  return `${arrived} / ${total}`
}

// The admin's business day runs 06:00 → 06:00 the next morning: an event that
// starts at 23:00 and an admin checking on it at 02:00 are the same working
// night. Before 6 AM we are still "yesterday" as far as the schedule is
// concerned. Returns a local YYYY-MM-DD string — never toISOString, which
// shifts by timezone.
const BUSINESS_DAY_START_HOUR = 6

const businessToday = (now) => {
  const d = now ? new Date(now) : new Date()
  if (d.getHours() < BUSINESS_DAY_START_HOUR) d.setDate(d.getDate() - 1)
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
}

// An event is over when the admin closed it, or when its end time has passed.
// An endTime before noon belongs to the following morning (a 22:00→04:00 night
// event dated the 10th actually ends at 04:00 on the 11th). Fails open: a
// malformed date/time counts as NOT ended, so a bad record stays visible rather
// than silently vanishing. Never throws.
const hasEnded = (event, now) => {
  const e = event || {}
  if (e.isClosed) return true
  if (!e.date || !e.endTime) return false
  try {
    const [y, m, d] = String(e.date).split('-').map(Number)
    const [h, min] = String(e.endTime).split(':').map(Number)
    const endDt = new Date(y, m - 1, d, h, min, 0, 0)
    if (h < 12) endDt.setDate(endDt.getDate() + 1)
    if (!isNaN(endDt.getTime()) && (now || new Date()) > endDt) return true
  } catch (_) {}
  return false
}

module.exports = {
  formatDate,
  formatTime,
  formatDateTime,
  formatPrice,
  formatPhone,
  getInitials,
  formatGuestCount,
  BUSINESS_DAY_START_HOUR,
  businessToday,
  hasEnded
}