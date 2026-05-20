const ENV_ID = 'cloud1-9g2yewom6a2d5467'

const ROLES = {
  ADMIN: 'admin',
  COUNTER: 'counter'
}

const EVENT_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CANCELLED: 'cancelled'
}

const TICKET_TYPES = {
  EARLY_BIRD: 'early_bird',
  GENERAL: 'general',
  VIP: 'vip'
}

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  REFUNDED: 'refunded'
}

const PROMOTER_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
}

const STORAGE_KEYS = {
  STAFF_USER: 'staffUser'
}

const COLLECTIONS = {
  STAFF: 'staff',
  EVENTS: 'events',
  VENUES: 'venues',
  GUESTS: 'registrations',
  PROMOTERS: 'promoters',
  WALLETS: 'wallets',
  TRANSACTIONS: 'transactions',
  PAYOUTS: 'payouts',
  MEMBERSHIPS: 'memberships',
  PURCHASES: 'purchases'
}

const CLOUD_FUNCTIONS = {
  LOGIN_STAFF: 'loginStaff',
  CHECK_IN_GUEST: 'checkInGuest',
  MANAGE_STAFF: 'manageStaff',
  MANAGE_APPLICATIONS: 'manageApplications',
  UPLOAD_IMAGE: 'uploadImageDirect'
}

module.exports = {
  ENV_ID,
  ROLES,
  EVENT_STATUS,
  TICKET_TYPES,
  PAYMENT_STATUS,
  PROMOTER_STATUS,
  STORAGE_KEYS,
  COLLECTIONS,
  CLOUD_FUNCTIONS
}