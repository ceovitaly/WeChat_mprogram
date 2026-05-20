const isRequired = (value) => {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

const isValidPrice = (value) => {
  return !isNaN(value) && Number(value) >= 0
}

const isValidCapacity = (value) => {
  return !isNaN(value) && Number(value) > 0 && Number.isInteger(Number(value))
}

const validateVenue = (data) => {
  const errors = []
  if (!isRequired(data.name)) errors.push('Venue name is required')
  if (!isRequired(data.password)) errors.push('Counter password is required')
  if (!isRequired(data.type)) errors.push('Venue type is required')
  return errors
}

const validateEvent = (data) => {
  const errors = []
  if (!isRequired(data.title)) errors.push('Event title is required')
  if (!isRequired(data.venueId)) errors.push('Venue is required')
  if (!isRequired(data.date)) errors.push('Date is required')
  if (!isRequired(data.startTime)) errors.push('Start time is required')
  return errors
}

const validateTicket = (data) => {
  const errors = []
  if (!isRequired(data.name)) errors.push('Ticket name is required')
  if (!isValidPrice(data.price)) errors.push('Valid price is required')
  return errors
}

module.exports = {
  isRequired,
  isValidPrice,
  isValidCapacity,
  validateVenue,
  validateEvent,
  validateTicket
}