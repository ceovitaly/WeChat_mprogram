# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ecosystem Overview

This is **Yue! (Gaming)** — the guest-facing WeChat mini-program. It shares a single WeChatCloud backend (env: `cloud1-9g2yewom6a2d5467`, resourceAppid: `wxb3ff00281bf0dca9`) with the admin app **Yue! Admin (Gaming)** at `~/WeChatProjects/Yue! Admin (Gaming)`.

Both apps share the same cloud environment and collections. Changes to cloud functions or the database structure affect both apps.

## Deployment

No build step. Development and deployment are done in **WeChat DevTools**:
- Mini-program root is `miniprogram/`
- Cloud functions deployed individually: right-click folder under `cloudfunctions/` → "Upload and Deploy"

## Architecture

### Guest onboarding flow (active)

The canonical registration flow lives in `pages/register/`:

1. `register.js` — checks if user exists in `guests` collection via `clientAuth` CF (`action: 'getMe'`)
2. If not registered: privacy agreement → WeChat `getPhoneNumber` button → calls `clientAuth` (`action: 'getPhone'`) to decrypt phone
3. Navigates to `pages/register/promo/promo` with phone as param
4. `promo.js` — user enters promoter's promo code → verified via `clientAuth` (`action: 'verifyPromoCode'`) against `promoters` collection
5. On success: guest profile saved to `guests` collection with phone, promoCode, promoterName

**The old onboarding flow in `me.js`** (WecChat nickname + `promo_codes` collection) is superseded by this flow and should not be extended.

### Cross-account cloud access

The guest app accesses the admin app's cloud using cross-account configuration:
```js
const cloud = new wx.cloud.Cloud({
  resourceAppid: 'wxb3ff00281bf0dca9',
  resourceEnv: 'cloud1-9g2yewom6a2d5467'
})
```
All cloud calls go through `app.getCloud(callback)` which waits for cloud to be ready. Never call `wx.cloud` directly — always use the cross-account instance from `app.globalData.cloud`.

### Cloud images

Events store images as `cloud://` URLs. Always resolve them with `cloud.getTempFileURL` before displaying. Batch all URLs in one call — see `feed.js` `resolveImages()` for the pattern.

### Cloud functions

- `login` — returns openid, called on app launch
- `clientAuth` — multi-action: `getMe`, `getPhone`, `verifyPromoCode`, `completeRegistration`
- `assignPromoter` — assigns a promoter to a guest

## Database Collections

| Collection | Written by | Purpose |
|---|---|---|
| `events` | Admin app | Event cards shown in the feed |
| `registrations` | Guest app | Guest sign-ups per event |
| `guests` | Guest app | Guest profiles (nickName, avatarUrl, phone, promoCode, promoterName) |
| `promoters` | Admin app | Promoters with `promoCode` field (status must be `'approved'`) |
| `promo_codes` | Legacy | Old promo code collection — do not use in new code |

## Known Issues

- `app.json` has no `tabBar` but `me.js:128` calls `wx.switchTab` — will throw; needs fixing
- `register.js:25` redirects to `/pages/feed/index` — wrong path, should be `/pages/feed/feed`
- `me.js` onboarding flow uses `promo_codes` collection — superseded by `register.js` flow using `promoters`
