# Free-entry replacement confirmation — Alpha Guest

The updated Guest uses `submitRegistrationWithConfirmation`. The first request returns the exact previous event names and a scope fingerprint before any transaction writes if cancellation is required. Confirm sends that fingerprint in a second request; Cancel sends no second request and creates no new registration. The server recomputes eligibility and the cancellation set before committing. Changed records or event names require fresh confirmation. Paid tickets and retained visits do not trigger this cancellation dialog.

Both event-detail and sign-in-with-pending-event use the same native modal flow with Confirm / Cancel. The loading mask is dismissed before the dialog. Scope data stays in memory and is not cached. The new action fails closed against an older backend that does not implement it.

The live clientAuth entry and switch helper were deployed as a scoped directory overlay over a privately downloaded baseline. Exact bundle readback confirmed the approved files, preserved unrelated files and unchanged runtime/timeout; see release.json. No registration handler, tests, builds or app walkthroughs were invoked.

Client publication is separate: the dialog appears only in an updated Alpha Guest build. The pre-existing submitRegistration action remains backward-compatible for already-published clients; it does not acquire a dialog that those clients cannot display. This is an explicit client-protocol migration, not a new rule for payment or historical report handling.
