# Ezra Mail roadmap

Current app version: **v0.8.2**. Experimental and pre-1.0.
Updated October 8, 2026. This is the public roadmap for Ezra-Mail-Self-Hosted;
private operational records and account data remain separate.

## Available in the app

- Gmail and Microsoft workspaces, saved views and local rules.
- Today's agenda, a fixed morning brief and separate later updates.
- Local-model triage, summaries and reply assistance.
- Exact-message review in the app's Outbox before sending.
- Account-aware calendar and Microsoft To Do views.
- Opt-in browser, Web Push and Telegram notifications with privacy controls.
- Trusted-device protections, backup/restore tooling and source installers.

Implementation does not establish acceptance on every device or provider.
Broader Windows/mobile installation and delivery testing remain open.

## Personal plugin checkpoint

The maintainer's October 8 MAIN-conversation acceptance run reported:

| Capability | Result and boundary |
| --- | --- |
| Personal Gmail and Microsoft identities | Passed; selected personal resources only |
| Mail search and cursor pagination | Passed; potentially incomplete local index |
| Full provider message read | Passed for sampled messages on both providers |
| Search snippets | Gmail snippets unavailable in all four samples |
| Calendars | Reads, create, title edit and delete passed for both providers |
| Microsoft To Do | Private list reads, create, title edit and completion passed |
| Duplicate prevention | Fixtures checked first; one operation/execution per action |

This is bounded acceptance evidence, not a guarantee for all fields or accounts.
Microsoft ordinary event deletion uses a fresh-read check, not atomic revision
protection; a concurrent external edit can race deletion. Lifecycle failure
injection and workstation-disconnected acceptance were not established by that
reported run. Earlier intermittent HTTP/catalog errors were not reproduced;
their cause remains unresolved.

See [the personal plugin guide](PERSONAL_PLUGIN.md). Plugin mail sending, drafts
and organization are not exposed, even though the app has an Outbox. Task deletion,
list management/sharing, meeting invitations and provider contact writes remain
unimplemented through this integration.

## Planned milestones

- [ ] **v0.8.0 — Notifications and installable clients**
  - Finish real-device installation and notification delivery acceptance.
  - Gather normal-use feedback on the daily brief and notification volume.
- [ ] **v0.9.0 — Broader provider support and personal actions**
  - Guided public plugin onboarding and reproducible provider qualification.
  - Broader account configurations; current agent profile requires a Gmail and
    a Microsoft account pair.
  - Complete lifecycle, expiry, outage, restart and uncertain-outcome acceptance.
  - Separately qualify plugin drafts, sending and mail organization.
  - Task/list creation, editing and removal where supported.
  - Calendar invitations, attendee updates, responses and meeting cancellation.
  - To Do collaboration, list invitations and assignment where the provider API
    permits them; API support still needs investigation.
  - Provider contacts: find, create and update selected fields conversationally,
    resolve ambiguous matches, prevent duplicates and preserve unrelated fields.
- [ ] **v0.9.9 — Modern UI/UX audit and product refinement**
  - Group repeated notification mail and offer controls for its visibility.
  - Summaries of the selected workspace or smart lane.
  - Easier event creation, faithful forwarding and Reply Studio layout fixes.
  - Audit everyday workflows, accessibility and responsive behavior, then finish
    broader device testing against the refined interface.
- [ ] **v1.0.0 — Self-hosted general availability**
  - Freeze features after refinement and complete supported installation,
    recovery, upgrade and provider acceptance.
- [ ] **Ezra Cloud**
  - A future hosted offering with separate operational and privacy policies.

## Reuse and support

The source is AGPL-3.0-only, with a separate commercial licensing route.
Use your own accounts, registrations, credentials and infrastructure. There is
no support SLA; workplace use requires your organization's approval.
