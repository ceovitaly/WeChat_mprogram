# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ecosystem Overview

This is **Yue! Admin (Gaming)** — one of two WeChat mini-programs sharing a single WeChatCloud backend (env: `cloud1-9g2yewom6a2d5467`). The companion guest-facing app is **Yue! (Gaming)** at `~/WeChatProjects/Yue! (Gaming)`.

Both apps share the same cloud environment and collections. Changes to cloud functions or database structure affect both apps.

## Deployment

There is no build step. Development and deployment happen entirely through **WeChat DevTools**:

- Open the project in WeChat DevTools (mini-program root is `miniprogram/`)
- Cloud functions are deployed individually: right-click any folder under `cloudfunctions/` → "Upload and Deploy"
- The `uploadCloudFunction.sh` script is a stub from the quickstart template — it is not functional

## Architecture

### Two-role mini-program

A single app serves two completely different user types, distinguished by login:

- **Admin** (`role: 'admin'`) → tab bar shows Schedule / Team / Stats → `pages/admin/*`
- **Counter/Staff** (`role: 'counter'`) → tab bar shows Work / Stats → `pages/counter/*`

The custom tab bar at `miniprogram/custom-tab-bar/` reads the role from storage and renders the correct tab list dynamically. Every page that is a tab page must call `this.getTabBar().updateTabs()` in `onShow` to keep the tab bar in sync.

### Auth flow

1. `pages/register/register` — login screen (username + password)
2. Calls `loginStaff` cloud function → returns `{ name, role, _id, openid }`
3. User saved to `wx.storage` key `staffUser` and `app.globalData`
4. `getStartPageByRole(role)` in `utils/auth.js` routes to the correct entry page
5. On every app launch, `app.js` restores session from storage if present

### Staff workspace flow (counter role)

`pages/counter/work/work` is a three-step single-page flow driven by `data.step`:
1. `'venue'` — enter venue password → queries `venues` collection by `password` field
2. `'event'` — lists upcoming events for that venue → select one
3. `'guests'` — guest list grouped by promoter, with search and check-in

Session is persisted to storage (`currentVenueId`, `currentVenueName`, `currentEvent`) so staff can close and reopen the app without re-entering the venue code.

### Cloud functions

All cloud functions use `wx-server-sdk` and follow the pattern:
```js
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async (event, context) => { ... }
```

Multi-action functions use an `action` string field as a dispatcher (like a mini-router):
- `manageApplications` — getRegistrations, getPromoters, updatePromoterStatus, updatePromoterCode, createPromoter, getStats, getAllGuests, deleteEvent
- `manageStaff` — getAll, add, update, delete

Single-purpose functions: `loginStaff`, `checkInGuest`, `uploadImageDirect`

### Miniprogram utilities

- `utils/request.js` — thin wrappers: `callFunction(name, data)`, `collection(name)`, `db()`
- `utils/auth.js` — session helpers: `saveUser`, `getStoredUser`, `clearUser`, `getStartPageByRole`
- `utils/constants.js` — single source of truth for `ENV_ID`, `ROLES`, `COLLECTIONS`, `CLOUD_FUNCTIONS`, status enums

Always import collection names from `COLLECTIONS` and cloud function names from `CLOUD_FUNCTIONS` — never hardcode strings.

## Database Collections

| Collection | Purpose |
|---|---|
| `staff` | Admin and counter accounts (name, password, role) |
| `venues` | Venues with `password` field used by counters to log in |
| `events` | Event cards (title, date, venueName, status, promoImages) |
| `registrations` | Guest sign-ups (eventId, guestName, promoterName, arrivedAt) |
| `promoters` | Promoter accounts with `promoCode` field |
| `promo_codes` | Legacy promo code collection (used only in guest app's old `me.js` flow) |
| `guests` | Guest profiles in the guest app (nickName, avatarUrl, promoCode, promoterName) |

Events reference venues by `venueName` string (not by `_id`). Keep this in mind when renaming venues.

## Known Issues (Guest App — Yue! (Gaming))

- `app.json` in the guest app has no `tabBar`, but `me.js` calls `wx.switchTab` — this will throw
- `register.js` redirects to `/pages/feed/index` which doesn't exist (correct path: `/pages/feed/feed`)
- Two parallel onboarding flows exist: `me.js` (checks `promo_codes` collection) and `register.js` (checks `promoters` via `clientAuth` CF) — only the `register.js` flow should be used going forward
