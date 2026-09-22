# Install from source

Ezra Mail v0.8.2 is an experimental self-hosted source release. These instructions
create a new installation with your own owner, accounts and model. Automated
checks use synthetic data; guided Windows/Ubuntu and native/device acceptance
remain incomplete. Direct internet exposure is unsupported.

## 1. Prerequisites and source

Use a trusted computer with Git, Node.js **22 LTS** and npm available in your
terminal. Node 22 is the qualification baseline; other majors are not covered by
that evidence. Windows PowerShell and Linux are the documented manual paths.
macOS is not qualified. Avoid cloud-synced folders and use a short local path.

```bash
git clone https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted.git
cd Ezra-Mail-Self-Hosted
node --version
npm --version
npm ci --ignore-scripts
node scripts/apply-dependency-patches.mjs
```

In PowerShell, use `npm.cmd` if execution policy prevents invoking `npm.ps1`.
Do not skip the explicit dependency patch: it verifies the required ExcelJS fix.
OpenClaw is not required for this manual standalone web/worker path.

## 2. Private configuration

Copy the example once, without overwriting an existing installation:

PowerShell:

```powershell
if (Test-Path .env.local) { throw 'Configuration already exists; preserve it.' }
Copy-Item .env.example .env.local
```

Linux:

```bash
test ! -e .env.local && (umask 077; cp .env.example .env.local)
```

Edit `.env.local` in a local text editor. For a first evaluation on this computer,
keep `APP_BASE_URL=http://127.0.0.1:3000` and the default local SQLite URL. Set
`EZRA_AUTH_SECURE_COOKIE` to `false` **only for this loopback HTTP setup**. Use `true`
with HTTPS. Leave all owner password/secret and provider fields blank; the
first-owner command creates the signing secret. Never enable
`EZRA_AUTH_ALLOW_UNCONFIGURED` in a real installation.

The example sets `EZRA_OPENCLAW_WORKSPACE` to `./data/assistant-memory` for the
worker's daily preference notes. Keep this private, writable directory even when
you do not install OpenClaw; do not clear the setting.

Keep `.env.local`, `data/`, downloaded provider configuration and recovery material
private and outside source control. On a shared computer restrict their filesystem
permissions to the account running Ezra. Windows users should use a private user
profile; Linux users should retain mode 0600 on the environment file.

## 3. Local model

Install and start [Ollama](https://docs.ollama.com/quickstart) yourself. No model
weights or account configuration are included in this repository. Keep its API on
loopback or another trusted endpoint you control. A model can require substantial
memory, disk and processing time; size it for your hardware.

One example, using the included default model definition:

```bash
ollama pull qwen3:8b
ollama create qwen3:8b-maxctx -f config/models/Qwen3-8B-MaxContext.Modelfile
ollama list
```

That definition requests a 40,960-token context. On smaller hardware, choose a
model/context that fits instead and set these variables in `.env.local`:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
EZRA_EMAIL_MODEL_REF=ollama/YOUR_INSTALLED_MODEL
OLLAMA_NUM_CTX=8192
```

Replace the model placeholder with the exact name from `ollama list`; context is
an example, not a hardware guarantee. `EZRA_EMAIL_MODEL_REF` overrides the app's
model setting. Remove that override if you want the app setting to choose.
The Windows `npm run models:setup` helper installs all three predefined models;
it is optional and can take considerable time and disk space.

You can create the owner and open the empty app before installing a model. AI
triage and drafting require a working model. Optional hosted model choices send
content to the chosen provider; local inference uses the configured Ollama endpoint.

## 4. Build, create the first owner, and run

From the project directory:

```bash
npm run build
npm run auth:bootstrap -- --origin http://127.0.0.1:3000 --transport local
npm start
```

The bootstrap command prints a private, single-use setup URL that expires after
15 minutes. Keep it in your terminal; do not paste it into issues or screenshots.
With the web server running, open that URL, create an owner password of at least
12 characters, and save the recovery code shown by the wizard in a safe place.
Add a passkey if your browser offers it. If the link expires before use, rerun the
bootstrap command after expiration. Existing owners must use normal sign-in;
bootstrap deliberately refuses to replace them.

Keep the web terminal running. Open another terminal in the same project directory:

```bash
npm run worker
```

Both processes use the same `.env.local` and local database. The worker is needed
for synchronization, background AI and notification processing. Open
`http://127.0.0.1:3000`, sign in and inspect Settings/System health. An empty inbox
is expected until you configure a provider. Use Ctrl+C in both terminals to stop.
The public `npm start` starts the existing production build on loopback; after
source changes, stop the processes and run `npm run build` again.

## 5. Connect only your own accounts

Follow [account setup](EMAIL_AGENT_SETUP.md). Microsoft needs your own public-client
app registration and Gmail needs your own Google OAuth client plus `gog` CLI.
Restart both web and worker after configuration changes. These steps grant real
provider permissions; automated release checks do not connect accounts or send mail.
Optional notifications are off until configured and explicitly enabled.

## Private server or guided installation

For another device to reach Ezra, configure your own trusted HTTPS proxy/private
network and set `APP_BASE_URL` to that exact HTTPS origin. Set secure cookies to
`true`, retain the app's loopback binding, and review
[the example proxy configuration](proxy-example.conf). Issue headless setup with
`npm run auth:bootstrap -- --origin https://ezra.example --transport lan` only
once your own private HTTPS origin works. `ezra.example` is a placeholder, not a
public service. Do not expose the app or Ollama directly to the internet.

The optional Windows launcher is `START HERE - Install Ezra Mail.bat`. It may
install additional tooling and models and configure startup/tray behavior; review
its prompts. The optional Ubuntu installer supports
`sudo bash installer/install-ezra-ubuntu.sh --desktop` or `--headless`, with
`--lan-origin` for a configured private HTTPS LAN origin. Review the scripts before
running them: they can create services, reverse-proxy settings and backup timers.
These guided paths still require installation acceptance and are not prerequisites
for the manual source path above.

## Backups, updates and troubleshooting

Back up the database, attachment files, protected configuration and any local key
material together. The `backup:create`, `backup:verify` and `backup:rehearse` npm
commands are available; inspect their output and preserve the files privately.
Before an update, stop web/worker, retain a verified backup and the old source
revision, then install dependencies, apply patches and build the chosen release.
The database initializes/migrates on startup. Restoring old source alone does not
undo a database migration.

- **Cannot sign in on loopback HTTP:** check the exact origin and the loopback-only
  secure-cookie setting above, then restart both processes.
- **No worker heartbeat or synchronization:** keep the worker terminal running and
  inspect local health. Share only sanitized errors, never mail or configuration.
- **Model unavailable:** compare the configured model name with `ollama list`, check
  the endpoint and choose a context size your machine can handle.
- **Provider unavailable:** follow the account guide and your organization's policy;
  an app registration or personal-account success does not grant workplace approval.

For source verification use `npm run lint`, `npm test`, `npm run build`,
`npm run license:check` and `npm run public:scan`. Browser tests additionally need
Playwright's matching browser dependencies. These checks use synthetic fixtures;
they do not establish real provider, native notification or installer acceptance.
