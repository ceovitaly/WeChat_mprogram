---
name: admin-dev
description: Use this agent for all development tasks in the Yue! Admin (Gaming) mini-program. Handles admin panel features (calendar, team, venues, events, stats) and staff workspace features (venue login, event selection, guest check-in). Spawn this agent when working on pages under miniprogram/pages/admin/ or miniprogram/pages/counter/, cloud functions under cloudfunctions/, or the custom tab bar.
---

You are a developer working exclusively on the **Yue! Admin (Gaming)** WeChat mini-program located at `~/WeChatProjects/Yue! Admin (Gaming)`.

## Your scope

- `miniprogram/pages/admin/*` — admin panel: calendar, team, venues, event editor, staff, promoters, guests, stats
- `miniprogram/pages/counter/*` — staff workspace: venue login → event list → guest check-in
- `miniprogram/pages/register/` — shared login screen
- `miniprogram/custom-tab-bar/` — role-aware tab bar
- `miniprogram/utils/` — request.js, auth.js, constants.js, format.js, validator.js
- `cloudfunctions/*` — loginStaff, manageStaff, manageApplications, checkInGuest, uploadImageDirect
- `miniprogram/components/` — shared components

## Key rules

**Always import from constants, never hardcode strings:**
```js
const { COLLECTIONS, CLOUD_FUNCTIONS, ROLES } = require('../../../utils/constants')
```

**Always use request utils, never call wx.cloud directly from pages:**
```js
const { callFunction, collection } = require('../../../utils/request')
```

**Every tab page must sync the tab bar in onShow:**
```js
onShow() {
  if (typeof this.getTabBar === 'function' && this.getTabBar()) {
    this.getTabBar().updateTabs()
    this.getTabBar().setData({ selected: <index> })
  }
}
```

**Cloud functions always start with:**
```js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
```

Multi-action cloud functions use an `action` string dispatcher — add new actions to the existing function rather than creating a new one when the domain fits.

## Roles

- `admin` → sees Schedule / Team / Stats tabs → `pages/admin/*`
- `counter` → sees Work / Stats tabs → `pages/counter/*`

Role is stored in `wx.storage` key `staffUser` and `app.globalData.role`. The custom tab bar reads from storage directly.

## Shared cloud

The cloud env `cloud1-9g2yewom6a2d5467` is shared with the guest app **Yue! (Gaming)**. Collections `events`, `registrations`, `venues`, `promoters`, `guests` are read/written by both apps. Changes to these collections or cloud functions affect both apps.

Events reference venues by `venueName` string field, not by `_id`. Keep this consistent.

## Page anatomy

Each page is 4 files: `.js`, `.wxml`, `.wxss`, `.json`. Always edit all relevant files together when implementing a feature — they are tightly coupled. Register any new components used in the page's `.json` file.
