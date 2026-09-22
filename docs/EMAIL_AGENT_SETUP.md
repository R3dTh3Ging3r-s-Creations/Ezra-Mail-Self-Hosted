# Ezra Mail account setup

Ezra Mail is self-hosted software. Configure accounts and access through your
own installation; do not commit account details, access tokens, or local
configuration files.

## Gmail

Ezra uses the separate [gog CLI](https://github.com/openclaw/gogcli) for Gmail.
Install it using the upstream installation guide, under the same OS account that
runs Ezra's web and worker processes. Check `gog --version` and `gog auth add
--help`: this integration requires `--readonly`, `--gmail-no-send`,
`--extra-scopes`, `--remote`, `--step` and `--auth-url`. CLI versions can change;
if these flags are unavailable, do not connect an account until compatibility is
resolved. Live Gmail acceptance is not part of the automated release gate.

In your own Google Cloud project, enable the Gmail API (and Calendar API if
wanted), configure the consent screen and create a **Desktop app** OAuth client.
Keep its downloaded JSON outside this repository. Register that file with
`gog auth credentials set YOUR_CLIENT_JSON_PATH` using your installed CLI's help.
Use your own account as a test user while the consent screen is in testing mode;
Google's testing/verification policies can affect token lifetime and availability.
See the [upstream quickstart](https://github.com/openclaw/gogcli/blob/main/docs/quickstart.md).

Set `GOG_PATH` in `.env.local` to your actual executable path (on Linux, `gog` is
sufficient when it is on the service account's PATH). Leave `GMAIL_ACCOUNTS` blank
until you deliberately configure an account. Restart web and worker, open Ezra's
Accounts view, enter your Gmail address and follow its sign-in flow. On a headless
host, Ezra uses the remote flow: open the displayed URL yourself and return the
final redirect URL only to your private Ezra installation. Never post it publicly.
Keyring access must work for the account running both processes; for a headless
file-backed keyring, follow upstream protected-storage instructions.

Initial setup from Ezra's Accounts view requests maintenance access, including
`https://www.googleapis.com/auth/gmail.modify`. Although the CLI command includes
`--readonly` and `--gmail-no-send`, it adds that modification scope explicitly;
do not treat the resulting OAuth grant as read-only. Calendar setup also adds
`https://www.googleapis.com/auth/calendar.events`. Review Google's actual consent
screen before approving. Ezra's app-level action checks are separate from the
provider's permission grant, and outgoing messages require exact-message review.

## Microsoft mail and calendar

Create [your own Microsoft app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
and copy its Application (client) ID into `MICROSOFT_CLIENT_ID` in `.env.local`.
Use delegated Microsoft Graph permissions with the public-client device-code flow;
no client secret is needed. Do not use the author's app registration or credentials.

Initial account setup currently requests `offline_access`, `User.Read`,
`Mail.Read` and **`Mail.ReadWrite`**. It is not a read-only connection. Calendar
setup adds **`Calendars.ReadWrite`**. Enabling replies separately adds
**`Mail.Send`** (and retains Calendar when already enabled). Configure/consent to
only the capabilities you intend to use. The provider's permission grant and
Ezra's per-action review are distinct: outgoing mail requires exact-message review,
and calendar drafts remain reviewable before provider actions.

For both personal and work/school accounts, select **Any Entra ID Tenant +
Personal Microsoft accounts** in the registration's supported accounts and set
`MICROSOFT_TENANT=common` in the installation's protected configuration.
The default is `common`; an explicitly configured `consumers` value still
restricts sign-in to personal accounts. Keep **Allow public client flows**
enabled for Ezra's device-code flow. This flow does not require a client secret.
Restart the installation's web and worker services after changing configuration.

Enter the intended mailbox address or Microsoft work sign-in name in Ezra.
Microsoft's sign-in page uses its own browser session; the address typed in Ezra
does not select that browser account. Choose **Use another account** if needed,
or open the sign-in link in a private browser window and enter the current code.
Ezra compares Microsoft's verified mailbox/sign-in identity with the requested
account before saving credentials. A mismatch or unverifiable identity saves no
connection and requires a fresh authorization. Additional mail aliases that
Microsoft does not return as the primary mailbox or sign-in name are not accepted;
use one of those verified addresses instead.

Workplace consent and sign-in policies still apply. An administrator may need to
approve the app, and some organizations block device-code sign-in. Publisher
verification is separate from app registration and does not override those policies.

## Notifications

Installing or trusting Ezra does not enable notifications. Open your configured
private HTTPS origin, enroll this browser under **Settings > System > Trusted
devices**, then choose **Delivery > Enable notifications** and grant browser
permission. Foreground alerts need an authenticated Ezra tab or installed window
open. Today remains available independently of external notification delivery.

For closed-window delivery, the installation owner must configure the safe names
in `.env.example`: `EZRA_BROWSER_NOTIFICATIONS_ENABLED`, `APP_BASE_URL`,
`EZRA_PUSH_KEY_ID`, `EZRA_PUSH_ENCRYPTION_KEY`,
`EZRA_VAPID_PUBLIC_KEY`, `EZRA_VAPID_PRIVATE_KEY`, and `EZRA_VAPID_SUBJECT`.
Keep key material private. **Enable background delivery** is a separate explicit
choice, available after the current owned app worker confirms support. It uses a
browser-controlled relay and an encrypted payload. Copy is generic by default;
**Show sender and subject on the lock screen** is a separate opt-in. Opening an
alert still needs connectivity to your private Ezra origin and may require sign-in.

Use the browser's installation controls where supported. On iPhone or iPad, add
Ezra to the Home Screen and open it there. Ezra checks available browser features;
installation metadata does not prove native delivery support. **Finish the app
update first** means save drafts, close all Ezra tabs and installed windows, and
reopen. Updates never force activation over open drafts. Origin or VAPID key changes,
a missing subscription, and expired setup require fresh explicit enrollment.

**Disable background delivery** removes background transport while preserving
foreground enrollment. **Disable this browser** removes the notification device.
Both revoke server delivery before native subscription cleanup. **Repair app
connection** also coordinates removal before unregistering Ezra's owned worker
when browser delivery is available. Browser permission remains under your control.
Failed or timed-out attachment retains the shared native subscription: refresh
settings and explicitly retry. A registered subscription can still have delivery
disabled; settings show that distinction and expiry. Operating-system Focus,
sleep, browser suppression, and network availability can prevent display even
after transport acceptance.

Normal cleanup finishes automatically after the actual browser promises settle.
If interrupted, settings identify the pending operation and its recovery steps.
Setup is paused on every browser using that exact origin; existing unrelated
enrolled delivery continues. Save work, close the initiating browser's Ezra tabs
and installed windows, and remove only that origin's worker and push subscription
using browser controls. Preserve unrelated storage and drafts. Then return to
**Interrupted cleanup recovery**, acknowledge the completed manual steps, and use
**Confirm interrupted cleanup** for that operation. Owner confirmation is separate
from observed native completion; a timeout alone never completes cleanup.

Before each deployment-wide activation of browser notifications, update and close
clients loaded with disabled or legacy cleanup behavior and finish their native
cleanup while delivery remains disabled. See the native acceptance procedure for
physical-browser qualification; synthetic CI fixtures are not native relay evidence.
### Telegram notifications

Configure the bot token and a canonical positive private owner chat ID using the
installation's protected configuration. A group chat ID is not supported. These
settings alone do not enable notifications. From the intended trusted device on
the configured private Ezra origin, open **Settings > Delivery** and choose
**Enable Telegram notifications** after reading the disclosure. Enabling replaces
the previous Telegram enrollment for that destination. The worker picks up the
binding on its next notification tick; `TELEGRAM_POLLING_ENABLED=false` keeps
commands disabled. The web Settings page does not observe the worker's running
state and does not start a second polling loop.

Telegram bots are not end-to-end encrypted. Copy is generic by default;
**Show sender and subject in Telegram notifications** is a separate explicit
privacy choice. **Send generic Telegram test** is available only when configured
and enrolled. It sends only when clicked, never on page load or policy save.
An accepted response is API acceptance, not proof of display or reading. Settings
show the last notification acceptance and failure independently of that test.

**Disable Telegram notifications** revokes the enrollment. Token, destination,
origin or trusted-device changes require fresh explicit enrollment; old message
buttons cannot authorize the replacement binding. **Useful** and **Too noisy**
record local notification feedback. **Snooze notifications** pauses notification
policy for one hour. **Open Ezra** and **/today** open the private authenticated
interface; no notification button creates, edits or sends mail. Old provider-action
buttons direct the owner back to Ezra. **/status** and **/help** describe local
notification controls. Polling accepts commands only from the configured owner in
that owner's private chat.

## Guided installation

On Windows, open `START HERE - Install Ezra Mail.bat`. The installer prepares
the protected local configuration, then opens a short-lived browser wizard for
the first owner. Create the owner password there, save the displayed recovery
code, and add a passkey if the browser offers one. Do not generate a password
hash or edit `.env.local` for normal installation.

On Ubuntu, from the extracted Ezra Mail application directory, run one of:

```bash
sudo bash installer/install-ezra-ubuntu.sh --desktop
sudo bash installer/install-ezra-ubuntu.sh --headless
```

The desktop mode opens the first-owner setup page. Headless mode prefers a
Tailscale HTTPS address; when Tailscale is unavailable, supply a private HTTPS
LAN address with `--lan-origin https://…`. The LAN proxy binds only to that
supplied address. The printed setup address is single-use and expires after 15 minutes.
Direct internet exposure is not supported. The installer also enables
daily verified backups and monthly restore-rehearsal timers.

The installer preserves an existing owner, trusted devices, passkeys, provider
credentials, database, attachments, models, backups, and recovery material on
upgrade. The interactive `npm run auth:recover` command is an emergency owner
recovery path, not a normal installation step.

## Operational hygiene

- Keep `.env.local` and provider client files out of Git.
- Use your operating system's protected credential storage when available.
- Review requested provider permissions before authorizing them.
- Update Ezra Mail and its dependencies before enabling new integrations.
