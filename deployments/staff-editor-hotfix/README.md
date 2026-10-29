# Admin Counter password editor

## Approved scope

The administrator explicitly selected keeping the currently deployed plaintext managed-password storage scheme and exposing a specific employee's password only to an authenticated administrator. This is not an encryption or authentication migration. Existing staff passwords must not be reset or rewritten during deployment.

## API and access boundary

- `manageStaff/getPassword` requires a trusted caller resolved from WeChat context with role `admin`, plus one staff document ID.
- The response contains that staff member's existing password only. Counters cannot use this action.
- `getAll` keeps credentials out of both admin and counter roster responses. The client must not cache passwords in `refCache` or its staff list.
- A stored `scrypt$` hash is never displayed as the original password. Such a record returns `PASSWORD_NOT_RECOVERABLE`; the administrator may explicitly set a replacement in the editable field, but deployment itself must not do that.
- Editing a name, phone, or role must not submit an unchanged password. New password text is submitted only after the administrator actually edits the field.
- The form clears credential state on close, hide, and unload and rejects stale asynchronous credential responses.

## Compatible cloud rollout

The downloaded live `manageStaff` and `loginStaff` use the older plaintext credential contract; uploading the former local hashed-password implementation alone would break new/changed Counter logins against the deployed `loginStaff`.

`apply-hotfix.js` patches a separately downloaded live `manageStaff/index.js` rather than publishing unrelated local cloud-function changes. It adds the admin-only single-password action, narrows the admin roster projection, and keeps existing plaintext add/update and login compatibility. It does not deploy `loginStaff`, alter runtime settings, install dependencies, or modify staff records.

```sh
node deployments/staff-editor-hotfix/apply-hotfix.js PRIVATE_LIVE_INDEX PRIVATE_STAGE/manageStaff/index.js
```

Incrementally deploy only the staged `manageStaff/index.js`. Before deploying, require the live source to match the saved baseline. Afterwards, download the exact function again and compare its source and non-index files; confirm `loginStaff` source and runtime/timeout are unchanged. These delivery readbacks are not a login or application behavior test.

## Client release

The source changes belong only to Alpha Admin's Counter management form. Guest and Beta are not changed. Publishing the cloud API does not publish the new form: the updated Alpha Admin client still needs the ordinary WeChat upload/review/publish process.

## Verification boundary

The user requested no tests/builds/compiler/app walkthroughs. Do not report any of those as passed. No current staff password should be printed in command output, artifacts, commits, or this document.
