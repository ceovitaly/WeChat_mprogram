const ENV_ID = 'cloud1-9g2yewom6a2d5467'

const ROLES = {
  ADMIN: 'admin',
  COUNTER: 'counter'
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
  REGISTRATIONS: 'registrations',
  PROMOTERS: 'promoters'
}

const CLOUD_FUNCTIONS = {
  LOGIN_STAFF: 'loginStaff',
  CHECK_IN_GUEST: 'checkInGuest',
  MANAGE_STAFF: 'manageStaff',
  MANAGE_APPLICATIONS: 'manageApplications'
}

module.exports = {
  ENV_ID,
  ROLES,
  PROMOTER_STATUS,
  STORAGE_KEYS,
  COLLECTIONS,
  CLOUD_FUNCTIONS
}