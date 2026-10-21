# Compatible cloud event-deletion hotfix

This is a patch recipe for the existing live `manageApplications/index.js`, not
an instruction to upload every local Alpha cloud function. Production source and
cloud configuration stay in private backups outside Git.

## Scope

- Preserve the live staff gate, QR helpers, remaining action handlers, dependencies,
  environment settings, runtime and timeout byte-for-byte / unchanged.
- Embed `delete-event.js` and replace only the existing `deleteEvent` action.
- Refuse deletion when **any payment order** exists for the event, or when ticket
  records contain paid/financial markers. Do not change orders, payment status,
  amounts, transaction references or ticket owners. This conservative guard also
  protects the existing synthetic TEST registration marked `paid`.
- For paid inventory without financial records, require a stable closed interval
  of 65 seconds before permanent deletion. This drains already-running payment
  requests without modifying `payments`; the existing createOrder rejects closed
  events. A first request may return `EVENT_DELETE_WAIT` and require a retry.
- Close registration before draining, serialize competing deletion attempts with
  a bounded ownership marker, remove only unchanged non-financial registrations
  in first-page batches, and require repeated empty reads.
- Return success only after authoritative event and registration counts are zero.
  Return both `error` and `message` for old client compatibility.
- On failure release only this attempt's deleting marker, keeping ordinary closure
  so new sales stop while existing paid-ticket recovery remains possible.
- Do not manually delete either reported event, execute a live deletion as a test,
  change the archival timer, or deploy `payments`/`clientAuth` as part of this fix.

## Prepare

Back up and download the actual live function. Supply its exact reviewed digest:

```sh
node deployments/event-deletion-hotfix/apply-hotfix.js \
  --source /private-backup/manageApplications/index.js \
  --output /private-staging/manageApplications/index.js \
  --expected-sha256 BASELINE_SHA256
```

The generator refuses an unexpected baseline or action layout. Reversing its two
substitutions must recover every original byte. The staging folder contains only
`index.js`; do not copy credentials, configuration or dependencies into it.

## Rollout

Re-download immediately before deployment and abort if the reviewed baseline has
changed. Use the existing function's incremental **single-file** update, wait for
`Active`, download again, and compare the full entry-point digest. Compare all
non-index files, runtime and timeout against the private baseline. A deploy CLI
exit code alone does not establish a completed asynchronous update.

The source under `cloudfunctions/manageApplications` may contain separate dirty
or undeployed work. Do not overwrite it with an older production baseline or
include its unrelated changes in this hotfix commit.

## Acceptance boundary

Client tests, compilation and app walkthroughs are intentionally not run under
the user's current manual-acceptance policy. Deployment metadata/source readback
is required separately. Verified deployed bytes do not prove that the user's
next deletion request reaches the handler or that a customer's ticket is visible.
A financial guard is a deliberate refusal, not a successful event deletion.

## Ticket incident observed during preparation

The cloud payment ownership hotfix was already deployed. A read-only sample of
the newest 30 orders contained four legacy October 16, 2026 records marked paid
whose paid registrations lacked `_openid`. This is not independent provider
payment verification and did not authorize a batch repair. Recent Free Entry
registrations were confirmed with owners; the Alpha Wallet's paid-only filter
also excluded them. Client display fixes require a separate Guest release.
