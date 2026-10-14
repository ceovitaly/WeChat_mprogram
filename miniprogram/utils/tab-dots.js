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

function updateEventDots(feedEvents, paidEvents, activeTab) {
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
    writeSeen(FEED_SEEN_KEY, eventIds(feedEvents));
    return setDots({ feed: false });
  }
  if (tab === 'events') {
    writeSeen(PAID_SEEN_KEY, eventIds(paidEvents));
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

function updateProfileDot(profile) {
  const music = profile && profile.music;
  const hasMusic = Array.isArray(music) ? music.length > 0 : hasText(music);
  const complete = !!profile &&
    hasText(profile.nickName || profile.name || '') &&
    hasText(profile.birthday || '') &&
    hasText(profile.gender || '') &&
    hasText(profile.country || '') &&
    hasMusic;
  return setDots({ profile: !complete });
}

module.exports = {
  getDots,
  subscribe,
  updateEventDots,
  markEventTabSeen,
  updateWalletDot,
  updateProfileDot
};
