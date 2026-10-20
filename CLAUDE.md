# The List (Guest)

Guest-facing WeChat Mini Program for events, registration, tickets, profile and venue galleries.

## Runtime

- Mini-program root: `miniprogram/`
- Guest AppID: `wxc016d0b6d4c61048`
- Shared cloud resource AppID: `wxb3ff00281bf0dca9`
- Cloud environment: `cloud1-9g2yewom6a2d5467`
- No build step; run through WeChat DevTools.

## Mandatory cloud access rule

All shared-cloud calls must use the cross-account instance initialized in `miniprogram/app.js` and obtained through `app.getCloud()`. Do not call the global `wx.cloud` API from pages.

## Authentication

`miniprogram/utils/auth.js` is the only source of truth for authorization.

- Authorized: a `guests` document exists for the current openid and `loggedOut` is not set.
- Anonymous: no guest document or explicit logout.
- Personalized UI must use `auth.getAuth(callback)`.
- Only `auth.completeSignIn(profile)` clears `loggedOut`.

## Onboarding

The canonical flow is the single `pages/register/register` page:

1. Resolve the existing session.
2. Obtain the verified phone number through `clientAuth/getPhone`.
3. Collect profile data and verify the promoter code.
4. Persist and re-read the full guest record.
5. If `pendingEventId` exists, submit the intended registration and open My List.

There is no separate `pages/register/promo` page and no active `assignPromoter` function.

## Pages

- `feed`: event feed, date/search filtering and navigation
- `gallery`: venue gallery tiles and photo view
- `event-detail`: event details, free registration and paid ticket selection
- `mytickets`: issued paid tickets in one shared Active/Past card layout; no pending-order or payment-retry UI; event end time determines the tab and QR check-in is active-only
- `me`: profile and preferences
- `register`: phone/profile onboarding
- `legal`: privacy and terms
- `webview`: external payment/content fallback

The app intentionally has no native tab bar. Use `navigateTo`, `navigateBack` or `reLaunch`, never `wx.switchTab`.

## Images and payments

Resolve `cloud://` images before display. Batch URLs and keep event rendering independent from optional gallery enrichment.

Paid tickets call the shared `payments` cloud function through `miniprogram/utils/pay.js`. A real HTTPS WeChat Pay notification URL must be configured; client confirmation and order polling remain recovery paths.

## Shared data

The guest app reads `events`, `venues` and `promoters`, and writes or updates `guests`, `registrations` and payment-backed `orders`. `promo_codes` is legacy and must not be used.
