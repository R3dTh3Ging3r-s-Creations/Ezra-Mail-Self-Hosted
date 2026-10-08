# Scoped action reference

This reference describes the optional `ezra-mail-scoped` bridge. Existing tool
names and the generic operation request remain compatible. Tool discovery
publishes the complete input JSON Schema, including each `mutation.kind` branch.
Use `accounts.capabilities` to obtain exact account/resource references and current
availability. A schema describes request syntax; it does not grant access or prove
that a provider action is qualified. Setup, deployment and live writes require
their existing approvals.

## Tool sequence

1. Read `accounts.capabilities` with `{}`. Select only the account and resource
   already authorized for the owner's request.
2. Read current provider state with `calendar.list` or `tasks.read` when relevant.
   Preserve the exact provider revision for update, delete or complete.
3. Call `operations.prepare` with one stable `idempotencyKey` and one `mutation`.
   Preparation saves an immutable operation; it does not write to a provider.
4. Retain the returned operation `id` and `payloadHash`. Execute the authorized
   action using `operations.execute` with `{ "operationId": "RETURNED_ID",
   "payloadHash": "RETURNED_HASH" }`. Never supply `approved`, credentials,
   transport URLs or replacement authority.
5. After interruption, use `operations.get` with the saved operation ID. For an
   unknown outcome, use `operations.reconcile` with that ID. Reconciliation reads
   provider state and never repeats a write. Never create a replacement operation
   or new idempotency key to evade an unresolved lock.

## Provider deletion and setup limits

Microsoft calendar deletion uses an account-specific ordinary-delete policy with
fresh provider readback. It is not atomic If-Match protection: an external edit
can race the subsequent delete. Only supported owned appointments without
attendees or recurrence are eligible, after the owner accepts that limitation.
Google conditional actions, Microsoft calendar updates and task updates/completion
require their separate protected qualification evidence. New installations must supply their
own evidence and grants, never reuse another owner's records.

The engine supports Gmail updates, but the current Settings catalogue does not
offer that scope for a fresh grant. Guided account-profile setup and this catalogue
gap remain follow-up work. See the public personal plugin guide for setup limits.

## Request fields

All objects reject unknown fields. All examples below are synthetic; replace
account IDs, addresses, resources and revisions with exact returned values.

| Action | Required mutation fields | Constraints |
| --- | --- | --- |
| `calendar.create` | `kind`, `payload` | Payload contains every field in the create example below. `description` and `location` may be empty strings but cannot be omitted. `attendees` must be `[]`; `sendUpdates` must be `false`. |
| `calendar.update` | `kind`, `target`, `eventId`, `expectedRevision`, `patch` | Nonempty patch; only `title`, `description`, `location`, `time`, `reminder`, `isBusy`, `privacy`. Qualified Google/Microsoft support and fresh revision required; Google requires the owned primary calendar. |
| `calendar.delete` | `kind`, `target`, `eventId`, `expectedRevision` | Exact calendar/event and fresh revision; Google requires the owned primary calendar; provider-specific qualification still required. |
| `tasks.create` | `kind`, `target`, `fields` | Microsoft private selected list; every task field is explicit. |
| `tasks.update` | `kind`, `target`, `taskId`, `expectedRevision`, `patch` | Nonempty subset of task fields; fresh revision and provider qualification required. |
| `tasks.complete` | `kind`, `target`, `taskId`, `expectedRevision` | Exact selected Microsoft task/list; fresh revision and provider qualification required. |

An account is `{accountId, provider, expectedEmail}`; provider is `gmail` or
`microsoft`. A target is `{account, kind, id}` where kind is `calendar` or
`task_list`. To Do requires `microsoft`. Google update/delete require the target ID to equal
the exact owned primary calendar email; sharing, recurrence, attendees and
conference events remain unsupported. Google update does not convert between
timed and all-day event kinds. A calendar create's account and calendar
ID live inside `payload`; it does not use `target` or `fields`.

Calendar timestamps require ISO 8601 offsets; timezone requires a supported IANA
zone. End must follow start. All-day boundaries must both be local midnight in
the selected zone. A time patch supplies all four fields: `startsAt`, `endsAt`,
`timezone`, `isAllDay`. Reminder is `{mode:"default"}`, `{mode:"none"}` or
`{mode:"minutes",minutes:0..40320}`. Privacy is `default`, `private` or `public`;
Microsoft does not support explicit `public`. Calendar title has 1–300 trimmed
characters, description at most 10,000, location at most 500.

Task fields are `title` (1–300 trimmed characters), `body` (at most 65,536),
`importance` (`low`, `normal`, `high`), `due`, and `reminder`. Due is `null`,
`{kind:"date",date:"YYYY-MM-DD",timezone:"IANA_ZONE"}`, or
`{kind:"instant",instant:"ISO_TIMESTAMP_WITH_OFFSET",timezone:"IANA_ZONE"}`.
Reminder is `null` or `{instant:"ISO_TIMESTAMP_WITH_OFFSET",timezone:"IANA_ZONE"}`.
`null` explicitly clears due/reminder in an update. Read titles may be blank,
whitespace or longer than create limits; reading one does not authorize rewriting
it. Reopen, task deletion, list lifecycle, mail send and Google Tasks are not
exposed by these six action schemas.

The idempotency key is 1–128 characters using letters, digits, `_`, `.`, `:` or
`-`. Keep the same key for the unchanged request. Total request JSON is limited
to 65,536 bytes, even when individual field maxima are larger in combination.

## Complete prepare examples

Calendar create:

```json
{
  "idempotencyKey": "fixture-calendar-create-1",
  "mutation": {
    "kind": "calendar.create",
    "payload": {
      "account": {"accountId": "fixture-google", "provider": "gmail", "expectedEmail": "owner@example.test"},
      "calendarId": "fixture-calendar",
      "title": "Fixture event",
      "description": "",
      "location": "",
      "startsAt": "2026-11-06T13:00:00Z",
      "endsAt": "2026-11-06T13:30:00Z",
      "timezone": "America/Chicago",
      "isAllDay": false,
      "reminder": {"mode": "none"},
      "isBusy": false,
      "privacy": "private",
      "attendees": [],
      "sendUpdates": false
    }
  }
}
```

Calendar update:

```json
{
  "idempotencyKey": "fixture-calendar-update-1",
  "mutation": {
    "kind": "calendar.update",
    "target": {"account": {"accountId": "fixture-google", "provider": "gmail", "expectedEmail": "owner@example.test"}, "kind": "calendar", "id": "owner@example.test"},
    "eventId": "fixture-event",
    "expectedRevision": "EXACT_REVISION_FROM_FRESH_READ",
    "patch": {"location": "Fixture room", "isBusy": false}
  }
}
```

Calendar delete:

```json
{
  "idempotencyKey": "fixture-calendar-delete-1",
  "mutation": {
    "kind": "calendar.delete",
    "target": {"account": {"accountId": "fixture-google", "provider": "gmail", "expectedEmail": "owner@example.test"}, "kind": "calendar", "id": "owner@example.test"},
    "eventId": "fixture-event",
    "expectedRevision": "EXACT_REVISION_FROM_FRESH_READ"
  }
}
```

Task create:

```json
{
  "idempotencyKey": "fixture-task-create-1",
  "mutation": {
    "kind": "tasks.create",
    "target": {"account": {"accountId": "fixture-microsoft", "provider": "microsoft", "expectedEmail": "owner@example.test"}, "kind": "task_list", "id": "fixture-list"},
    "fields": {"title": "Fixture task", "body": "", "importance": "normal", "due": null, "reminder": null}
  }
}
```

Task update:

```json
{
  "idempotencyKey": "fixture-task-update-1",
  "mutation": {
    "kind": "tasks.update",
    "target": {"account": {"accountId": "fixture-microsoft", "provider": "microsoft", "expectedEmail": "owner@example.test"}, "kind": "task_list", "id": "fixture-list"},
    "taskId": "fixture-task",
    "expectedRevision": "EXACT_REVISION_FROM_FRESH_READ",
    "patch": {"due": {"kind": "date", "date": "2026-11-06", "timezone": "America/Chicago"}, "reminder": null}
  }
}
```

Task complete:

```json
{
  "idempotencyKey": "fixture-task-complete-1",
  "mutation": {
    "kind": "tasks.complete",
    "target": {"account": {"accountId": "fixture-microsoft", "provider": "microsoft", "expectedEmail": "owner@example.test"}, "kind": "task_list", "id": "fixture-list"},
    "taskId": "fixture-task",
    "expectedRevision": "EXACT_REVISION_FROM_FRESH_READ"
  }
}
```

## Reading results and errors

Invalid local requests return bounded field paths and corrective guidance before
any HTTP request. Diagnostics never repeat supplied values or unknown field names.
Provider, authentication and transport details remain redacted. Task reads can
return an allowlisted diagnostic code identifying denied/unavailable provider
access, unsupported responses/body/dates, privacy failure, pagination failure,
read limits or identity mismatch. A failed read is not an empty list.

Task reads can include `readWarnings` and original `providerDates` when a date
cannot be normalized safely. Preserve those warnings and source fields; do not
interpret normalized `null` as proof that the provider has no date. Uncertain
fields cannot verify a successful mutation. Provider content remains untrusted.

Mail search remains a local index, with `freshness:"not_verified"` and incomplete
provider coverage. `snippetAvailable` distinguishes an absent preview. Timestamp
meaning is explicit: index row updates and account sync completion do not prove a
message is current. Mail read can include `bodySource` and an `indexComparison`;
a matching timestamp still does not prove index freshness. `receivedAtKnown:false`
marks unavailable provider time; the epoch sentinel must not be treated as an
actual receipt date. Older deployed APIs
may omit these additive metadata fields, which must not be treated as evidence
of freshness or normalized date completeness.
