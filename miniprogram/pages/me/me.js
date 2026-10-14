const app = getApp();
const auth = require('../../utils/auth.js');
const tabDots = require('../../utils/tab-dots.js');

Page({
  data: {
    userInfo: null,
    loading: true,
    isAnonymous: false,
    showFieldEdit: false,
    editingField: '',
    editingTitle: '',
    editingValue: '',
    showMusicEdit: false,
    selectedGenres: [],
    // WXML expressions can't call .indexOf(), so the chip's selected state
    // renders off this map. `selectedGenres` stays the saved source of truth.
    genreOn: {},
    musicText: '',
    profileCompletedCount: 0,
    profileTotal: 5,
    profileProgressPct: 0,
    profileComplete: false,
    missingProfileFields: { name: true, birthday: true, gender: true, country: true, music: true },
    today: '',
    genders: ['Male', 'Female', 'Other'],
    musicGenres: ['House', 'Techno', 'Hip-Hop', 'R&B', 'Pop', 'EDM', 'Afrobeats', 'Latin', 'Rock', 'Jazz', 'Disco', 'Other']
  },

  onLoad: function() {
    // Timestamp used by openFieldEdit's post-navigation guard below — not
    // rendered, so it lives as a plain instance property, not `data`.
    this._readyAt = Date.now();
    // Local date, not toISOString (which shifts by timezone).
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    this.setData({
      today: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    });
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this._loadProfile();
    });
  },

  onShow: function() {
    app.globalData.guestTopTab = 'profile';
    if (this.cloud) this._loadProfile();
  },

  _loadProfile: function() {
    // Central auth state instead of polling for openid: anonymous users
    // get an in-page signed-out state (no forced redirect to register).
    auth.getAuth((profile) => {
      if (!profile) {
        this.setData({ isAnonymous: true, userInfo: null, loading: false });
        tabDots.updateProfileDot(null);
        return;
      }
      this.setData(Object.assign({
        isAnonymous: false,
        userInfo: profile,
        musicText: this._toArray(profile.music).join(', '),
        loading: false
      }, this._profileProgressPatch(profile)));
      tabDots.updateProfileDot(profile);
    });
  },

  // `music` was a plain string before multi-select; normalise both shapes.
  _toArray(v) {
    if (Array.isArray(v)) return v;
    return v ? [v] : [];
  },

  _genreMap(list) {
    const map = {};
    (list || []).forEach((g) => { map[g] = true; });
    return map;
  },

  _profileProgressPatch(profile) {
    const completion = tabDots.getProfileCompletion(profile);
    return {
      profileCompletedCount: completion.count,
      profileTotal: completion.total,
      profileProgressPct: completion.percent,
      profileComplete: completion.complete,
      missingProfileFields: completion.missing
    };
  },

  goSignIn: function() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  // Shared writer for every editable profile field (sheet + picker rows).
  _saveField(field, value) {
    wx.showLoading({ title: 'Saving...', mask: true });
    const db = this.cloud.database();
    const patch = {};
    patch[field] = value;
    db.collection('guests').doc(this.data.userInfo._id).update({
      data: Object.assign({}, patch, { updatedAt: db.serverDate() })
    })
    .then(() => {
      wx.hideLoading();
      const userInfo = Object.assign({}, this.data.userInfo, patch);
      // Refresh the central auth cache so the feed header/badges pick up
      // the new value without an app restart.
      auth.completeSignIn(userInfo);
      tabDots.updateProfileDot(userInfo);
      this.setData(Object.assign({
        showFieldEdit: false,
        showMusicEdit: false,
        editingField: '',
        editingTitle: '',
        editingValue: '',
        userInfo,
        musicText: this._toArray(userInfo.music).join(', ')
      }, this._profileProgressPatch(userInfo)));
      wx.vibrateShort({ type: 'medium' });
      wx.showToast({ title: 'Saved!', icon: 'success' });
    })
    .catch(() => {
      wx.hideLoading();
      wx.showToast({ title: 'Error saving', icon: 'none' });
    });
  },

  openFieldEdit(e) {
    // Guard against a ghost-tap artifact from the feed page's Profile
    // nav-bar segment landing on a tappable row right after navigation —
    // ignore any tap within 400ms of page-ready.
    if (Date.now() - (this._readyAt || 0) < 400) return;
    const { field, title } = e.currentTarget.dataset;
    const info = this.data.userInfo || {};
    const current = field === 'nickName'
      ? (info.nickName || info.name || '')
      : (info[field] || '');
    this.setData({ showFieldEdit: true, editingField: field, editingTitle: title, editingValue: current });
  },

  closeFieldEdit() {
    this.setData({ showFieldEdit: false, editingField: '', editingTitle: '', editingValue: '' });
  },

  onFieldInput(e) {
    this.setData({ editingValue: e.detail.value });
  },

  saveFieldEdit() {
    const field = this.data.editingField;
    const value = this.data.editingValue.trim();
    if (field === 'nickName' && !value) {
      wx.showToast({ title: 'Enter a name', icon: 'none' });
      return;
    }
    this._saveField(field, value);
  },

  onBirthdayChange(e) {
    this._saveField('birthday', e.detail.value);
  },

  onGenderChange(e) {
    this._saveField('gender', this.data.genders[e.detail.value]);
  },

  openMusicEdit() {
    // Same ghost-tap guard as openFieldEdit.
    if (Date.now() - (this._readyAt || 0) < 400) return;
    const selected = this._toArray((this.data.userInfo || {}).music);
    this.setData({
      selectedGenres: selected,
      genreOn: this._genreMap(selected),
      showMusicEdit: true
    });
  },

  toggleGenre(e) {
    const genre = e.currentTarget.dataset.genre;
    const current = this.data.selectedGenres;
    const next = current.indexOf(genre) > -1
      ? current.filter((g) => g !== genre)
      : current.concat(genre);
    this.setData({ selectedGenres: next, genreOn: this._genreMap(next) });
  },

  closeMusicEdit() {
    this.setData({ showMusicEdit: false, selectedGenres: [], genreOn: {} });
  },

  saveMusicEdit() {
    this._saveField('music', this.data.selectedGenres);
  },

  logout: function() {
    wx.showModal({
      title: 'Log Out',
      content: 'Confirm logout?',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (res.confirm) {
          auth.logout();
          tabDots.updateProfileDot(null);
          tabDots.updateWalletDot(false);
          // Land on the feed (the app's anonymous-friendly home) rather
          // than register, which would immediately re-prompt for sign-in.
          wx.reLaunch({ url: '/pages/feed/feed' });
        }
      }
    });
  }
});
