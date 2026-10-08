# Personal conversation integration

Ezra can connect a private installation to a normal ChatGPT conversation using
an MCP bridge. Each installation uses its own provider accounts, scoped Ezra
key, private tunnel, OpenAI runtime key and custom plugin registration. This
repository does not give access to the maintainer's running service.

**Current status: advanced setup, not a one-click public plugin.** The source
supports the actions below, but installation-specific account configuration and
provider qualification are still required. Guided public onboarding is roadmap
work. Do not interpret successful tests on the maintainer's installation as
permission or qualification for a different installation.

## What has been exercised

The October 8, 2026 MAIN-conversation acceptance report covered one personal
Gmail account and one personal Microsoft account:

| Action | Evidence and current boundary |
| --- | --- |
| Account identities and capabilities | Both selected identities verified |
| Mail search and pagination | Two pages per account; local index may be incomplete |
| Mail read | Sampled full provider bodies on both accounts, without truncation |
| Gmail search snippets | Unavailable in the four sampled results |
| Calendar read | Complete bounded range reads on both providers |
| Calendar create, title edit, delete | Each sequence verified on both providers |
| Microsoft To Do | Three private lists read; create, title edit and completion verified |
| Mail drafts, sending, organization | Not exposed by this plugin |
| Task deletion and list management | Not exposed |
| Invitations, shared tasks and contact writes | Planned; not exposed |

The app's exact-review Outbox is separate from plugin capabilities. Schema
support alone does not enable a scope. The current Settings catalogue does not
offer Gmail calendar.update to a fresh grant even though its underlying engine
was qualified on the maintainer's installation. This onboarding gap is tracked;
do not work around it by copying someone else's grant or qualification data.

## How it connects

```text
Your ChatGPT conversation
    -> your private Secure MCP Tunnel
    -> tunnel runtime + scoped stdio bridge on your Linux server
    -> your Ezra HTTPS API
    -> your selected Gmail / Microsoft resources
```

The server service runs independently of a Windows workstation or Codex. Its
bridge uses the scoped HTTPS API, not direct mailbox tokens or database access.
Returned mail, calendar and task content crosses into ChatGPT when requested;
local AI summaries elsewhere in Ezra do not make plugin tool results local-only.

OpenAI documents an outbound-only tunnel connection and separate account/workspace
requirements. Check availability in your own account before planning installation.
The tunnel is for private connections; it is not a public plugin-directory
submission route. See [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Create your own private connection through ChatGPT's custom MCP server flow and
select your own tunnel. Keep its audience limited to the owner because this bridge
holds one standing owner grant, not independent credentials for multiple users.
See [custom MCP server setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Access and qualification

Start with the [app installation](DEPLOYMENT.md) and
[provider account setup](EMAIL_AGENT_SETUP.md). Provider consent and the Ezra
scoped grant are separate requirements. Calendar writes need provider calendar
write access; Microsoft To Do writes need Tasks.ReadWrite. Read-only use needs
the corresponding provider read access. Do not grant mail sending merely to use
calendar or task tools.

The current agent account profile requires **exactly one Gmail and one Microsoft
account**, identified by their verified internal account ID, provider and email.
The protected agent_personal_accounts setting must be configured by the local
operator; there is not yet a supported first-run GUI for this step. It is separate
from the normal app Accounts page. Single-account and arbitrary multi-account
agent configurations are not currently supported.

Once the profile is established, Settings > Permissions > Agent access selects
exact accounts, calendars and private To Do lists, an expiry and allowed actions:
accounts.read, mail.read, calendar.read/create/update/delete, and
tasks.read/create/update/complete. Writes start unchecked. Issue with the owner's
passkey and store the key securely on the server. Issuing a key does not bypass
provider or qualification checks.

Conditional calendar writes and task editing/completion require protected operator
evidence matching the adapter and action; task evidence also binds to the exact
account. Google needs the supplied compatible calendar helper. Microsoft ordinary
calendar deletion has a separate account-bound policy: it checks the current item
before deletion but cannot atomically prevent an outside edit in between. It is
limited to supported owned appointments without attendees/recurrence. Acceptance
of that race and verification using disposable fixtures are prerequisites.
Never invent qualification records or reuse the maintainer's evidence.

## Operation handling

A write is prepared with one stable idempotency key and an immutable payload.
Execution uses the returned operation ID and payload hash. Verify the receipt and
provider result. If execution becomes uncertain, retain that operation and use
read-only reconciliation; do not create a replacement or clear its lock blindly.
Check for existing matches before making disposable test items.

If the host reports a changed tool catalogue, refresh discovery before preparing
anything else. Inspect the existing operation before retrying a failed request.
Do not parse a text-only error as JSON or discard its safe error message.

## Build and install the advanced source

The [Linux bridge source and operator checklist](../plugins/ezra-mail/linux/README.md)
include a locked source builder, runtime, service template and regression tests.
The [action reference](../plugins/ezra-mail/SCOPED_ACTIONS.md) documents exact inputs.
The standalone tunnel runtime is a separate, independently reviewed dependency.

## Remaining public setup work

- Provide a guided operator account-profile setup and qualification procedure.
- Correct the Gmail update grant catalogue and verify a fresh installation.
- Qualify an independently obtainable tunnel runtime; private build receipts and
  credentials must not be reused by other installations.
- Verify the whole flow from a fresh owner's MAIN conversation with the workstation
  disconnected, including renewal, revocation, restart and outage behavior.

The October acceptance report did not establish those fresh-install or failure
injection checks. Existing source tests and reported live success are useful
evidence, not a claim that the full integration is complete.
