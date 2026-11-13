# Missing historical event must not block a new registration

The free-registration switch scanned all of an owner's free entries, including historical/orphaned registrations. A successful transaction read returning no previous event raised REGISTRATION_EVENT_UNAVAILABLE before the new booking or its confirmation dialog could proceed.

Skip only a successfully read, absent previous event. Preserve its registration, arrival evidence and financial/history data unchanged; do not remove it or change event counters. Existing paid-ticket protections, active-event cancellation confirmation and three-hour retention remain unchanged. Actual database read failures still throw and must not be reclassified as missing documents.

A scoped read-only audit of the affected owner's registrations confirmed a free historical row referencing a missing event. No customer records were repaired, removed or created. The one-file clientAuth helper overlay was deployed and the exact live bundle downloaded again for hash comparison; unrelated source and runtime settings were preserved. See release.json. Tests and application/registration handlers were not run. No Guest client change is required for this server-side correction.
