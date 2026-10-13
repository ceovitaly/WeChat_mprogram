# Be Social (Admin)

Admin and staff-facing WeChat Mini Program for The List ecosystem.

## Runtime

- Mini-program root: `miniprogram/`
- Cloud functions: `cloudfunctions/`
- AppID: `wxb3ff00281bf0dca9`
- Cloud environment: `cloud1-9g2yewom6a2d5467`
- No build step; run and upload through WeChat DevTools.

## Roles and navigation

- `admin`: Schedule, Events, Main
- `counter`: Work

`Main` links to Team, Past Events, Stats, Reports and Ads. Reports and Ads are currently placeholders.

Every tab page must synchronize `miniprogram/custom-tab-bar/` from `onShow`.

## Authentication

`pages/register/register` calls `loginStaff`. The session is stored under `staffUser` and restored by `miniprogram/app.js`.

Staff passwords are stored as scrypt hashes. `loginStaff` accepts legacy plaintext records only to migrate them after a successful login. Roster APIs and UI must never return or display stored passwords. A generated password is shown once when an account is created; editing with an empty password keeps the current password.

## Main modules

- `pages/admin/calendar/`: schedule calendar
- `pages/admin/events/`: event list
- `pages/admin/main/`: admin hub
- `pages/admin/team/`: links to venues, staff, promoters and guests
- `pages/admin/stats/`: promoter statistics
- `pages/admin/past-events/`: closed event history
- `pages/counter/work/`: venue login, event selection, guest check-in and rotating QR
- `packageAdmin/pages/admin/`: editors and large management pages

Utilities include `request`, `auth`, `constants`, `format`, `validator`, `refCache`, `liveSync`, `phoneMatch`, `qrCode`, and `xlsx`.

## Cloud functions

- `loginStaff`: staff authentication and legacy password migration
- `manageStaff`: staff CRUD with role enforcement
- `manageApplications`: events, venues, promoters, guests, registrations, reports and QR issuance
- `clientAuth`: guest-safe reads, onboarding, registration and QR validation
- `checkInGuest`: staff check-in path
- `payments`: WeChat Pay order lifecycle

`manageApplications` and `clientAuth` require the same `CHECKIN_SECRET` environment variable. `payments` requires the variables documented in `../SECURITY.md`.

## Data invariants

- Events contain both `venueId` and `venueName`; renames must cascade the denormalized name.
- Promoter names are denormalized into guests and registrations; promoter renames must cascade.
- Registration IDs and order flows are designed to be idempotent. Preserve idempotency because `utils/request.js` retries one failed cloud call.
- Pages that add display fields must update both the `.js` data mapping and the `.wxml` template.
