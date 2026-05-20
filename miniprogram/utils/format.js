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

module.exports = {
  formatDate,
  formatTime,
  formatDateTime,
  formatPrice,
  formatPhone,
  getInitials,
  formatGuestCount
}