# Single current free registration — Alpha

## Business rule

- Paid registrations, orders, purchased entitlements and payment issuance are not replaced by this rule.
- A successful registration for a different free event removes the guest's earlier free registration while that earlier event is still running and the visit has lasted less than three hours. This includes registrations without an arrival mark.
- Keep earlier visits once the server-side attendance timestamp is at least three hours old, or the earlier event has finished by its configured Shanghai end time or has been manually closed. A retained three-hour visit receives a persistent retention marker.
- Existing ended-event history is kept. This is not a bulk cleanup or a migration of stored reports.
- A removed active-event registration is absent from the registration source used to build the final report at event close. Previously frozen reports for finished events remain unchanged because those registrations are kept.

## Implementation

`clientAuth/switchFreeRegistration.js` is shared by the normal `submitRegistration` and legacy `completeRegistration` actions. It uses a CloudBase transaction for old-record removals, the new record, event counts and the guest's current-free-registration cursor. The cursor is read and written inside the transaction so simultaneous requests to different events contend on the same profile. Candidate records and events are re-read inside the transaction before deciding what can be removed.

The server derives ownership from WeChat context. Only explicit free-entry records without financial markers are candidates. An in-flight/unresolved payment or an ambiguous existing ticket owner blocks replacement rather than allowing a financial record to be overwritten or deleted. Missing reliable attendance times also block destructive replacement; an HH:MM-only device value is not proof of a three-hour stay.

Both scan-driven arrival (`clientAuth`) and manual arrival (`checkInGuest`) preserve retained visits and protected tickets when applying the existing overlapping-venue cleanup. Repeated manual arrival does not restart an existing attendance timestamp.

Removing a registration increments the old event's `freeRegistrationRemovalVersion`. Updated Counter and Admin list clients use it to trigger a full refresh: the normal changed-row delta cannot remove a document that no longer exists. Guest event-detail refreshes its registration state on return and clears a stale registered state when no row remains. Wallet/Feed retain their existing fetch-on-return behavior.

## Delivery / rollout boundary

The owner authorized activation in the shared environment. Both `checkInGuest` and `clientAuth` were updated using a private live-based overlay. The deployed source was downloaded again and every file compared: required entries/helpers match the approved overlay, unrelated bundle files and runtime/timeout are unchanged. See `release.json`. No registration or arrival handler was invoked for verification, and no customer records were migrated by the deployment. Client publication remains separate.

`apply-live-policy.py` reproduces the scoped entry-point transformation on a separately downloaded baseline without printing its contents or copying embedded configuration into Git. Supporting helper files must accompany the transformed entries.

Changed source is in Alpha only; Beta source is not synchronized. The backend environment is shared, so deploying `clientAuth` changes behavior for every caller of that environment, not just a locally named Alpha folder.

Deploy the policy modules with `clientAuth`, and the policy module with `checkInGuest`, before publishing updated clients. Download the actual live bundles first and apply only these policy edits to them: local cloud-function files have unrelated pre-existing changes and must not be blindly uploaded wholesale. Upload supporting modules before entry points if incremental deployment is used. Preserve runtime settings, authorization configuration, payment functions and credentials. Back up the live sources and verify the exact deployed files by downloading them again.

Do not expose the new Guest registration UI while the old server registration handler is still active. To refresh open staff lists immediately after removals, publish the updated Alpha Admin clients as well.

No tests, builds, compiler commands or app walkthroughs were run, following the user's standing instruction. Source commits and GitHub publication are not a cloud deployment, Mini Program publication or verification of runtime behavior.
