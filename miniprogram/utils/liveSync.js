const { collection } = require('./request')

// ─── Live sync: "watch as a trigger, refetch through the existing path" ───────
//
// Guest lists are assembled server-side by cloud functions (they join guest phone
// numbers, on-duty staff and event data onto each registration row), so a raw
// client-side collection query would produce a poorer shape and can't replace the
// fetch. Instead the real-time DB listener is used purely as a *change signal*:
// whenever a matching document changes, we call back and the page re-runs its own
// existing fetch, preserving all of its join/build logic unchanged.
//
// This replaces unconditional short-interval polling. When the watcher works, an
// idle page issues ~zero cloud requests; requests happen only when data actually
// changed.
//
// Four details make it safe on a live door-staff screen:
//   1. init-snapshot skip — .watch() delivers an immediate `type: 'init'` snapshot
//      on connect. The caller has just fetched that same data itself, so acting on
//      it would be a wasted duplicate request. It is ignored.
//   2. Debounce — changes arrive in bursts (several check-ins at once). They are
//      coalesced into a single onChange call `debounceMs` after the last event.
//   3. Polling fallback — `registrations` and friends are normally read through a
//      cloud function, so client-side read permissions may not allow a watcher at
//      all (and .watch() also needs a recent base library). Any watcher onError —
//      or an outright throw during setup, e.g. ".watch is not a function" — logs
//      and degrades to a `pollMs` interval instead of breaking the page.
//   4. Full teardown — stop() closes the watcher (inside try/catch: closing an
//      already-errored watcher can throw), clears the pending debounce timeout and
//      the poll interval, and nulls every handle. It is safe to call when nothing
//      is running and safe to call repeatedly.
//
// This module knows nothing about page state, setData, loading flags or what the
// caller does in response — it is only a "something changed remotely, re-read now"
// signal source. All refetch logic stays in the page, including any staleness
// guards (a page that can switch between entities should re-check which entity it
// is showing inside its own onChange callback).
//
// Usage:
//   this._stopLive = startLiveSync({
//     collection: COLLECTIONS.REGISTRATIONS,
//     where: { eventId },
//     label: '[event-guests]',
//     onChange: () => this._fetch({ silent: true })
//   })
//   ...
//   this._stopLive()   // in onHide / onUnload / when switching entity

// startLiveSync(options) -> stop()
// options:
//   collection  {string}   collection name (use COLLECTIONS.*)
//   where       {object}   plain query object, e.g. { eventId }
//   onChange    {function} called, debounced, when remote data changed
//   debounceMs  {number}   burst coalescing window, default 600
//   pollMs      {number}   fallback poll interval, default 30000
//   label       {string}   console log prefix, e.g. '[work]'
const startLiveSync = (options = {}) => {
  const {
    collection: collectionName,
    where = {},
    onChange,
    debounceMs = 600,
    pollMs = 30000,
    label = '[liveSync]'
  } = options

  let watcher = null
  let debounceTimer = null
  let pollTimer = null
  let stopped = false

  const fire = () => {
    if (stopped) return
    if (typeof onChange === 'function') onChange()
  }

  const startPolling = () => {
    if (stopped) return
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(fire, pollMs)
  }

  const stop = () => {
    stopped = true
    if (watcher) {
      // Closing an already-errored watcher can throw — never let that break teardown.
      try { watcher.close() } catch (e) {}
      watcher = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  if (!collectionName || typeof onChange !== 'function') return stop

  try {
    watcher = collection(collectionName).where(where).watch({
      onChange: (snapshot) => {
        if (stopped) return
        // Skip the initial snapshot — the caller has just fetched this data.
        if (snapshot && snapshot.type === 'init') return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          fire()
        }, debounceMs)
      },
      onError: (err) => {
        console.error(`${label} ${collectionName} watch error, falling back to polling:`, err)
        watcher = null
        startPolling()
      }
    })
  } catch (err) {
    // e.g. ".watch is not a function" on an older base library
    console.error(`${label} ${collectionName} watch unavailable, falling back to polling:`, err)
    watcher = null
    startPolling()
  }

  return stop
}

module.exports = {
  startLiveSync
}
