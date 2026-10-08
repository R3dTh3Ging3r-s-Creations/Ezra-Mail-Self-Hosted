# Pinned gog calendar extension

This source extension applies only to openclaw/gogcli v0.43.0 commit
`3b5122f4c81c5df6df38ee48e01327f1034364ee`. Upstream is MIT licensed;
retain its LICENSE when distributing the resulting binary. Ezra's added files
follow this repository's license. No upstream source is vendored here.

Upstream reference: https://github.com/openclaw/gogcli/tree/3b5122f4c81c5df6df38ee48e01327f1034364ee

`calendar ezra-event <calendarId> <eventId> --account <email> --mode read|delete
--json --no-input` returns an `ezra-event-v1` envelope bound to every selector.
Deletion additionally requires `--if-match <opaque-etag> --force`. It verifies
the authenticated primary calendar's ID and owner access, exact event identity,
self creator/organizer, and excludes attendees, recurrence and conference data.
It sends one DELETE with If-Match and sendUpdates=none. OAuth stays inside gog's
existing credential boundary. Direct-token and ADC modes are rejected.

The wrapper rejects redirects, bounds response size, suppresses provider error
bodies, and disables upstream retries without replacing authentication. A 412
is distinguished from uncertain outcomes. A verified exact-event 404 or exact
nonrecurring cancelled tombstone can establish absence only after the owned
primary calendar was verified. Initial absence returns not_dispatched for a
delete command. Other errors, including 410, never prove absence or success.
Application readback checks the same event after deletion. Losing the helper
response leaves the operation unknown; reconciliation reads without redispatch.

Updates use `--mode update --if-match <opaque-etag> --force --patch-stdin
--patch-sha256 <sha256>` and a separate `ezra-event-update-v1` envelope. The
application sends the exact minimal JSON patch through stdin (maximum 64 KiB),
never through command arguments. The helper verifies its SHA256 and a strict
field allowlist, rejects duplicate JSON names, and makes one conditional PATCH
with `sendUpdates=none`. The response binds account/calendar/event, old revision
and exact patch hash. A 412 is terminal; no automatic retry changes the revision.
The application checks changed fields, preserved fields, a new provider ETag and
an independent readback before success. Lost-response updates remain unknown;
matching later contents alone never establish which dispatch changed the event.

Supported fields are title, description/location (including clears), explicit
busy/privacy, default/no/popup reminders, and complete start/end/timezone changes.
Timed events remain timed and all-day events remain all-day; changing between
those representations is unavailable pending a separately verified contract.
Attendees, recurrence, meetings, locked events and event-type changes are excluded.
The existing v1 read/delete wire format and delete qualification remain intact.

## Local build and synthetic qualification

Use a separate clean checkout at the exact commit above and Go 1.27.1. Fetch
upstream/dependencies through the normal approved development process first.
The script does not download, install, alter runtime configuration, or contact a
provider. It requires dependencies already in the Go module cache and refuses
unrelated source modifications or an existing output binary. Set GOPATH/GOCACHE
to short isolated paths on Windows. Keep all output/cache paths below 180 chars.

```
node tools/gog-ezra/build.mjs --source <exact-upstream-checkout> --go <go-executable> --output <new-output-binary>
```

The script checks the pin, copies the two extension files, registers the command,
runs synthetic exact-event and upstream reminder tests, and builds gog with
trimmed source paths. The upstream create command supports `--no-reminders`;
Ezra's existing typed reminderMode=none uses that flag and fails closed on an
older installed helper. There is no automatic helper installation or startup
upgrade. Review the produced binary hash and license alongside deployment.

## Activation remains separately gated

The existing helper/runtime is unchanged. Installation and GOG_PATH selection
require the separate deployment proposal and approval. Google conditional-delete
support requires protected `agent_conditional_support:gmail:calendar.delete`
evidence with version=1, provider=gmail, apiVersion=v3, adapterRevision=1,
helperRevision=ezra-event-v1, action=calendar.delete, source=live_authorized_probe,
staleRevisionRejected=true, a valid evidenceId and verifiedAt. Synthetic tests
cannot supply this evidence. An owner-approved calendar.delete scope and fresh
granted key for the exact personal account/calendar are additional prerequisites.
Google update requires its own protected `agent_conditional_support:gmail:calendar.update`
evidence with action=calendar.update and helperRevision=ezra-event-update-v1;
the other evidence fields above remain mandatory. Delete evidence never enables
updates. The new helper must be installed and its exact update path qualified
with separately approved disposable stale-revision and fidelity fixtures before
any availability claim or owner grant revision. Microsoft update/complete gates
and the failed Hotmail deletion hold are unchanged. Google Tasks remain unsupported.
No live provider create, update, delete, credential export, qualification or grant
change is part of this build procedure.

Provider contracts: [conditional modification](https://developers.google.com/workspace/calendar/api/guides/version-resources)
and [event PATCH](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).
Documentation of If-Match is not a substitute for action-specific live qualification.
