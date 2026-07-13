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

### Auth state (mandatory)

`utils/auth.js` is the single source of truth for "is the user signed in". Always gate personalized UI through `auth.getAuth(callback)` — never read `app.globalData.openid`, `app.globalData.userInfo`, or the `userInfo` storage key directly in pages.

- **Authorized** = a `guests` record exists for this openid AND the `loggedOut` storage flag is not set. Auto-recognition of a returning user (cache cleared, guest record exists) counts as authorized.
- **Anonymous** = no guest record, or `loggedOut` set. Anonymous users see zero personalized UI (no badges, tickets, or profile) — only sign-in CTAs.
- The `loggedOut` flag is set only by `auth.logout()` and cleared ONLY by `auth.completeSignIn(profile)` on a successful sign-in — never on read. `completeSignIn` must receive the full guest doc from the DB (with `_id`/`_openid`).
- `getAuth` memoizes per app session; call `auth.invalidateAuth()` after any sign-in/sign-out transition (`logout`/`completeSignIn` already do).

### Guest onboarding flow (active)

The canonical registration flow lives in `pages/register/` as one page with in-page steps (`step: 'phone' | 'profile'` — the old separate `pages/register/promo/` page no longer exists):

1. `register.js` `_checkSession` — resolves auth via `auth.getAuth`; authorized users are sent straight to the feed
2. Phone step: WeChat `getPhoneNumber` button → `clientAuth` (`action: 'getPhone'`) decrypts the phone; if a `guests` record already exists, the user is signed back in via `auth.completeSignIn`
3. Profile step: name + promoter's promo code → verified via `clientAuth` (`action: 'verifyPromoCode'`) against `promoters` collection
4. On success: guest profile saved to `guests` (phone, nickName, promoCode, promoterId, promoterName), re-read from the DB, then `auth.completeSignIn`
5. If the user arrived from an event page (`pendingEventId` storage key, set by event-detail's `goRegister`), they are auto-registered for that event — with a dedup check against `registrations` first — and land on My List

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
- `clientAuth` — multi-action: `getMe`, `getPhone`, `verifyPromoCode`, `completeRegistration`, `resolveImages` (`getMe` and `completeRegistration` are currently unused by the app)
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

- `app.json` has no `tabBar` — never use `wx.switchTab`; navigate with `navigateTo`/`reLaunch`
