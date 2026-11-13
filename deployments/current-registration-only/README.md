# Current booking only: non-blocking event-change consequences

This supersedes the all-time validation described in earlier rollout documents.

## Scope

- Track one current free entry using the owner profile cursor. Do not enumerate, paginate or revalidate the guest's registration history.
- For older profiles with no cursor, look up at most one recent free entry: an owner-scoped query from the previous Shanghai calendar day onward, ordered by creation time, limit 1. This bounded compatibility bootstrap is not an all-time migration. A stale cursor snapshot is left alone without fetching its historical event.
- Check the destination for an existing registration and normal event availability. Authentication, ownership protection, event closure and ticket availability remain unchanged; prior-event issues are not booking prohibitions.
- Preserve paid/protected entries, finished visits and visits of at least three hours. Missing events, unknown arrival times, pending old payments or unavailable prior data cause the old entry to be kept rather than a refusal to register elsewhere. On an optional previous-data read failure, retry in a fresh transaction with preservation, without depending on that old lookup.
- Change only the current eligible free entry after the guest confirms cancellation. Commit that consequence, destination booking, owner cursor and counters together. Kept entries and unrelated historical rows are not rewritten or bulk-cleaned.

## Notification and compatibility

Alpha Guest sends registrationNoticeVersion 2. The dialog explains whether the previous named entry will be cancelled or kept, including the three-hour/finished-event reason, and offers Confirm / Cancel. Retention due to unverifiable old details is informational and does not prevent continuing. Existing clients that understand only cancellation previews do not receive an incompatible retained-only preview.

Scanning a door QR and manually marking an arrival now update only the selected registration. The former all-history overlapping-venue cleanup was removed from both clientAuth and checkInGuest. Those paths no longer clear marks belonging to other events. Returned supersededEvents remains an empty array for wire compatibility.

## Delivery boundary

Both functions were deployed over privately downloaded live baselines. Exact source readback confirmed the approved overlays, unchanged unrelated files and unchanged runtime/timeout; see release.json. No customer data migration, registration handler, tests, build or app walkthrough was run. Backend changes apply to the shared environment; Beta source was not synchronized. Publish the updated Alpha Guest client to expose the expanded consequence text. Source commits and deployed-source readback are not functional/UI test results.
