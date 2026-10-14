const FEED_SEEN_KEY = 'tab_dots_seen_feed_events';
const PAID_SEEN_KEY = 'tab_dots_seen_paid_events';
const EMPTY_DOTS = { feed: false, wallet: false, events: false, profile: false };
const listeners = [];

function getState() {
  const app = getApp();
  if (!app.globalData.tabDots) {
    app.globalData.tabDots = Object.assign({}, EMPTY_DOTS);
  }
  return app.globalData.tabDots;
}

function getDots() {
  return Object.assign({}, getState());
}

function notify() {
  const snapshot = getDots();
  listeners.slice().forEach((listener) => listener(snapshot));
}

function setDots(patch) {
  const state = getState();
  let changed = false;
  Object.keys(patch || {}).forEach((key) => {
    const value = !!patch[key];
    if (state[key] !== value) {
      state[key] = value;
      changed = true;
    }
  });
  if (changed) notify();
  return getDots();
}

function subscribe(listener) {
  if (typeof listener !== 'function') return function() {};
  listeners.push(listener);
  listener(getDots());
  return function() {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

function eventIds(events) {
  const ids = [];
  (events || []).forEach((event) => {
    if (event && event._id && ids.indexOf(event._id) === -1) ids.push(event._id);
  });
  return ids;
}

function readSeen(key) {
  try {
    const value = wx.getStorageSync(key);
    return Array.isArray(value) ? value : null;
  } catch (e) {
    return null;
  }
}

function writeSeen(key, ids) {
  try {
    wx.setStorageSync(key, ids);
  } catch (e) {}
}

function calculateUnseen(key, ids) {
  const seen = readSeen(key);
  if (seen === null) {
    writeSeen(key, ids);
    return false;
  }
  return ids.some((id) => seen.indexOf(id) === -1);
}

function getUnseenEventIds(events, tab) {
  const key = tab === 'events' ? PAID_SEEN_KEY : FEED_SEEN_KEY;
  const seen = readSeen(key);
  if (seen === null) return [];
  return eventIds(events).filter((id) => seen.indexOf(id) === -1);
}

function updateEventDots(feedEvents, paidEvents, activeTab, collectionReady) {
  if (collectionReady === false) return getDots();
  const feedIds = eventIds(feedEvents);
  const paidIds = eventIds(paidEvents);
  let feed = calculateUnseen(FEED_SEEN_KEY, feedIds);
  let events = calculateUnseen(PAID_SEEN_KEY, paidIds);

  if (activeTab === 'feed') {
    writeSeen(FEED_SEEN_KEY, feedIds);
    feed = false;
  } else if (activeTab === 'events') {
    writeSeen(PAID_SEEN_KEY, paidIds);
    events = false;
  }

  return setDots({ feed, events });
}

function markEventTabSeen(tab, feedEvents, paidEvents) {
  if (tab === 'feed') {
    const ids = eventIds(feedEvents);
    if (ids.length > 0 || readSeen(FEED_SEEN_KEY) !== null) writeSeen(FEED_SEEN_KEY, ids);
    return setDots({ feed: false });
  }
  if (tab === 'events') {
    const ids = eventIds(paidEvents);
    if (ids.length > 0 || readSeen(PAID_SEEN_KEY) !== null) writeSeen(PAID_SEEN_KEY, ids);
    return setDots({ events: false });
  }
  return getDots();
}

function updateWalletDot(hasActiveTicket) {
  return setDots({ wallet: !!hasActiveTicket });
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getProfileCompletion(profile) {
  const music = profile && profile.music;
  const missing = {
    name: !profile || !hasText(profile.nickName || profile.name || ''),
    birthday: !profile || !hasText(profile.birthday || ''),
    gender: !profile || !hasText(profile.gender || ''),
    country: !profile || !hasText(profile.country || ''),
    music: !profile || !(Array.isArray(music) ? music.length > 0 : hasText(music))
  };
  const total = Object.keys(missing).length;
  const count = Object.keys(missing).filter((key) => !missing[key]).length;
  return {
    complete: count === total,
    count,
    total,
    percent: Math.round(count / total * 100),
    missing
  };
}

function updateProfileDot(profile) {
  return setDots({ profile: !getProfileCompletion(profile).complete });
}

module.exports = {
  getDots,
  subscribe,
  getUnseenEventIds,
  updateEventDots,
  markEventTabSeen,
  updateWalletDot,
  updateProfileDot,
  getProfileCompletion
};
