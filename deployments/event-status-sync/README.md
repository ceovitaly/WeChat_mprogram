# Guest feed: server-owned event-status synchronization

Registration already used the Shanghai end deadline from freeRegistrationPolicy.eventHasFinished, but getEvents returned stored active status without reconciliation. Automatic archival ran only when Admin's upcoming list was opened. An expired event therefore remained active in Guest while registration correctly returned EVENT_OVER.

Guest getEvents now queries active/nonclosed/nondeleting events, evaluates the same server-side Shanghai deadline, conditionally persists status=closed and omits expired records from its response. Updates match the previously read schedule so a concurrent admin reschedule cannot be closed by a stale read. Batches are bounded to ten concurrent updates. The Guest clock does not decide feed completion.

This changes status only, not isClosed, reports, images, registrations or payments. Existing Admin report-freezing/photo-archival behavior remains responsible for the separate archival flag. No historical report repair or bulk registration cleanup is included.

The clientAuth overlay was applied to a fresh downloaded live baseline and exact full-bundle readback verified the changed entry and unchanged supporting files/runtime/timeout. The reported REVO event's expired status was separately updated with an exact conditional native database write and read back as closed. No tests, builds or app walkthroughs were run; this is deployed-source and database-state verification, not visual acceptance. The backend fix is compatible with the existing getEvents payload and requires no Guest publication.
