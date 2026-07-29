// ─── Reference-data cache: "fetch the slow-moving lists once per session" ────
//
// Venues, promoters and the staff roster change a handful of times a week, but
// they were being refetched from a cloud function on every entry into
// event-edit, event-guests, guests and counter/work — several redundant cloud
// requests per navigation, each one delaying first paint. This is a tiny
// in-memory TTL cache in front of those three lists.
//
// Deliberately in-memory only (a module-level object, no wx.setStorageSync):
// persisting an org's roster across app restarts turns a stale read into a
// correctness hazard that survives a reload, and memory is enough — the goal is
// only to stop *repeated* refetches inside one session.
//
// ── Loader contract (important) ─────────────────────────────────────────────
// `get(key, loader)` caches whatever `loader()` RESOLVES with. Failures must
// REJECT: a rejected loader is never cached, so the next call retries.
//
// The cloud functions here answer failures with `{ success: false, ... }`
// instead of rejecting, so the cache cannot detect them itself. Turning that
// response into a rejection is the *call site's* job — its loader wrapper does:
//
//   const res = await callFunction(...)
//   if (!res || !res.success) throw failedResponseError(res, 'getPromoters failed')
//   return res.data || []
//
// and its catch block recovers the original response with `cloudResponseOf(err)`
// (or asks `isFailedResponse(err)` whether the server answered at all) so
// existing behaviour — isUnauthorized handling, tolerant silent reads, toasts —
// is preserved exactly. Those helpers live here so every call site spells the
// same contract the same way.
//
// ── In-flight de-duplication ────────────────────────────────────────────────
// Two pages asking for the same key before the first load resolves share one
// promise, so the loader runs once. Pages that fire several reads in onLoad
// (guests: promoters + staff; work: staff + promoters) therefore never stack
// duplicate requests either.
//
// ── Staleness ───────────────────────────────────────────────────────────────
// A cache that outlives an admin's edit is worse than no cache, so every
// mutation of these entities calls invalidate() immediately after the server
// confirms it, and the management screens (promoters / staff / venue-list)
// bypass the cache entirely — they fetch fresh and then set() the result, both
// because an admin opening "Promoters" expects current data and because that
// keeps the shared copy warm for everyone else.

const { callFunction } = require('./request')
const { CLOUD_FUNCTIONS } = require('./constants')

// Default lifetime for reference lists. Tune here, not at the call sites.
const DEFAULT_TTL = 5 * 60 * 1000

// Cache keys. Use these rather than raw strings so an invalidation can never
// silently miss the entry a reader populated.
const KEYS = {
  VENUES: 'venues',
  PROMOTERS: 'promoters',
  STAFF: 'staff'
}

// key -> { value, at }  — resolved entries
const entries = {}
// key -> Promise        — loads currently in flight
const inFlight = {}

// Wraps a `{ success: false }` cloud response in a rejection the cache
// understands, keeping the response itself reachable via cloudResponseOf.
const failedResponseError = (res, message) => {
  const err = new Error(message || 'Cloud response was not successful')
  err.cloudResponse = res || null
  return err
}

// True when the loader rejected because the cloud function answered non-success
// (as opposed to callFunction itself throwing — network error, missing function).
// Note a non-success answer can legitimately be an empty/undefined response, so
// this must be a presence check, not a truthiness check on cloudResponse.
const isFailedResponse = (err) => !!err && err.cloudResponse !== undefined

// The cloud response behind a failedResponseError, or null when the loader blew
// up for some other reason (network throw from callFunction, etc.).
const cloudResponseOf = (err) => (err && err.cloudResponse) || null

// get(key, loader, ttlMs) -> Promise<value>
// Resolves from cache when the entry is younger than ttlMs; otherwise awaits
// loader(), caches what it resolves with, and returns it. Concurrent callers
// share a single loader run. A rejecting loader is never cached — the rejection
// is passed through to every waiting caller and the next call retries.
const get = (key, loader, ttlMs = DEFAULT_TTL) => {
  const entry = entries[key]
  if (entry && (Date.now() - entry.at) < ttlMs) {
    return Promise.resolve(entry.value)
  }
  if (inFlight[key]) return inFlight[key]

  const promise = Promise.resolve()
    .then(() => loader())
    .then((value) => {
      entries[key] = { value, at: Date.now() }
      delete inFlight[key]
      return value
    })
    .catch((err) => {
      // Never cache a failure, and never leave a rejected promise pinned as the
      // in-flight one — the next caller must be able to retry.
      delete inFlight[key]
      throw err
    })

  inFlight[key] = promise
  return promise
}

// set(key, value) — seed the cache with data fetched elsewhere. Used by the
// management screens, which always read fresh and then share what they got.
const set = (key, value) => {
  entries[key] = { value, at: Date.now() }
}

// invalidate(key) — drop one key. Also drops any in-flight load: a mutation
// that lands mid-fetch would otherwise be overwritten by the older response.
// Callers already awaiting that promise still receive the pre-mutation value,
// which is why mutating pages update their own list locally as they always did.
const invalidate = (key) => {
  delete entries[key]
  delete inFlight[key]
}

// invalidateAll() — drop everything (e.g. on logout / account switch).
const invalidateAll = () => {
  Object.keys(entries).forEach((k) => { delete entries[k] })
  Object.keys(inFlight).forEach((k) => { delete inFlight[k] })
}

// ─── Shared loaders ──────────────────────────────────────────────────────────
// The three lists are read with identical payloads from four different pages,
// so the request lives here once. Each follows the loader contract above.

const loadVenues = async () => {
  // Server-side read — the venues collection is not client-readable.
  const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getVenues' })
  if (!res || !res.success) throw failedResponseError(res, 'getVenues failed')
  return res.data || []
}

const loadPromoters = async () => {
  const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getPromoters' })
  if (!res || !res.success) throw failedResponseError(res, 'getPromoters failed')
  return res.data || []
}

const loadStaff = async () => {
  const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_STAFF, { action: 'getAll' })
  if (!res || !res.success) throw failedResponseError(res, 'getAll (staff) failed')
  return res.data || []
}

// Convenience readers — the shape every consumer actually wants.
const getVenues = (ttlMs) => get(KEYS.VENUES, loadVenues, ttlMs)
const getPromoters = (ttlMs) => get(KEYS.PROMOTERS, loadPromoters, ttlMs)
const getStaff = (ttlMs) => get(KEYS.STAFF, loadStaff, ttlMs)

module.exports = {
  DEFAULT_TTL,
  KEYS,
  get,
  set,
  invalidate,
  invalidateAll,
  failedResponseError,
  isFailedResponse,
  cloudResponseOf,
  getVenues,
  getPromoters,
  getStaff
}
