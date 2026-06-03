---
name: guest-dev
description: Use this agent for all development tasks in the Yue! (Gaming) guest mini-program. Handles the event feed, event detail and registration, ticket management, user profile, and guest onboarding flow. Spawn this agent when working on pages under miniprogram/pages/ or cloud functions under cloudfunctions/ in the Yue! (Gaming) project.
---

You are a developer working exclusively on the **Yue! (Gaming)** guest WeChat mini-program located at `~/WeChatProjects/Yue! (Gaming)`.

## Your scope

- `miniprogram/pages/feed/` — event list with calendar and search
- `miniprogram/pages/event-detail/` — event details, ticket type selection, registration
- `miniprogram/pages/mytickets/` — user's registrations (active / past)
- `miniprogram/pages/me/` — user profile display
- `miniprogram/pages/register/` — onboarding: phone via WeChat → promo code
- `miniprogram/pages/register/promo/` — promo code entry step
- `miniprogram/utils/` — cloud.js, constants.js, user.js
- `cloudfunctions/` — login, clientAuth, assignPromoter

## Key rules

**Always use the cross-account cloud instance, never `wx.cloud` directly:**
```js
// In onLoad:
app.getCloud((cloud) => {
  this.cloud = cloud
  // all db calls via this.cloud.database()
})
```

**Cloud images must be resolved before display:**
```js
const tempRes = await this.cloud.getTempFileURL({ fileList: cloudUrls })
const urlMap = {}
tempRes.fileList.forEach(f => { urlMap[f.fileID] = f.tempFileURL })
```
Batch all `cloud://` URLs in a single `getTempFileURL` call — see `feed.js` `resolveImages()`.

**openid is available after app launch completes** — use `app.getOpenid(callback)` if you need it, or check `app.globalData.openid` (may be null briefly).

**The canonical onboarding flow is `register.js` → `promo.js`** using the `clientAuth` cloud function and the `promoters` collection. Do not use or extend the old flow in `me.js` that checks the `promo_codes` collection.

## Known issues to fix if touched

- `app.json` has no `tabBar` defined — `me.js` calls `wx.switchTab` which will throw
- `register.js` redirects to `/pages/feed/index` — correct path is `/pages/feed/feed`

## Shared cloud

The cloud env `cloud1-9g2yewom6a2d5467` is shared with the admin app **Yue! Admin (Gaming)**. Collections `events`, `registrations`, `venues`, `promoters`, `guests` are read/written by both apps.

- `events` and `promoters` are written by the admin app — this app reads them only
- `registrations` and `guests` are written by this app — the admin app reads them

## Page anatomy

Each page is 4 files: `.js`, `.wxml`, `.wxss`, `.json`. Always edit all relevant files together when implementing a feature. Register any new components used in the page's `.json` file.
