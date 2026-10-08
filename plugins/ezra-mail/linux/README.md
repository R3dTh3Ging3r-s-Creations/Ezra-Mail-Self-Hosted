# Linux personal MCP bridge

This package is advanced self-hosted source. It is not a hosted service, a plugin
store submission or a turnkey installer. Start with the
[capabilities and setup limits](../../../docs/PERSONAL_PLUGIN.md). Use your own
accounts, keys and private tunnel. The existing runtime source is reused here;
no maintainer credentials, account profile or qualification records are supplied.

## Before building

You need a clean Git clone of this public repository, Node.js 22 LTS and the locked
npm dependencies. Downloading a ZIP is insufficient: the builder checks tracked
inputs and records Git HEAD. For the server, use Linux with systemd encrypted
credentials, a root-controlled Node executable, getfacl, trusted HTTPS access to
your Ezra origin, and outbound access required by your tunnel service.

The separate tunnel runtime is not bundled. Obtain a reviewed runtime from
[OpenAI tunnel-client](https://github.com/openai/tunnel-client), verify its release
provenance and current dependency findings, and qualify it on your Linux host.
The maintainer used a privately patched runtime; this publication does not certify
an arbitrary upstream version or distribute that private binary. Check the
[official tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for current prerequisites. If an acceptable runtime is unavailable, stop here.

From the clean public checkout:

```sh
npm ci --ignore-scripts
node scripts/apply-dependency-patches.mjs
node --import tsx plugins/ezra-mail/linux/build-agent-linux.ts --output PRIVATE_OWNER_RECOVERY/bridge
```

Output must be a new, compact directory. The builder emits bridge.cjs, release.json
and THIRD-PARTY-NOTICES.txt. It checks locked esbuild, tracked source, module closure
and dependency licenses, then records a bundle hash. The manifest revision is the
**public checkout's** Git SHA; never substitute a private deployment revision.
No credentials or live-provider operations are involved in building.

## Server installation checklist

An administrator performs installation; the running bridge must be non-root.
This is a checklist for a reviewed host configuration, not an unattended installer.

1. Install and configure the Ezra app separately. Establish your own verified
   personal account profile and provider consent as described in the capability
   guide. Keep app backups and operation records intact.
2. Create a non-login ezra-mcp user/group without sudo, Docker or app-data-group
   membership. Verify the actual Node executable path and system CA trust.
3. Copy the three build artifacts to the exact immutable release directory under
   `/opt/ezra-mail-cloud-mcp/releases/REVISION`. Replace REVISION with the public
   build's full Git SHA. Use root-owned, mode 0444 files and root-controlled
   parent directories; do not use symlinks or a current-release link.
4. Install the separately verified tunnel runtime at
   /opt/ezra-mail-cloud-mcp/tunnel-client-runtime, owned and controlled by root.
5. Write /etc/ezra-mail-cloud-mcp/profile.json with this NONSECRET structure.
   Replace every placeholder from the verified release.json and your own setup:

```json
{
  "enabled": true,
  "origin": "https://mail.example.test",
  "qualifiedRevision": "YOUR_40_CHARACTER_PUBLIC_GIT_SHA",
  "releaseDirectory": "/opt/ezra-mail-cloud-mcp/releases/REVISION",
  "bundleSha256": "YOUR_64_CHARACTER_BUNDLE_SHA256",
  "nodeExecutable": "/usr/local/bin/node"
}
```

The profile must be root-owned, non-writable and readable by the service
(for example 0444; it contains no key). The actual Node path must match both the
profile and service command. The HTTPS origin cannot contain a path, credentials,
query or fragment. Never disable TLS validation to make it connect.

6. Create your own private tunnel and dedicated OpenAI runtime key with only the
   required tunnel read/use permissions. In Ezra, review exact personal resources,
   actions and expiry, and issue a separate scoped key using your passkey.
7. Through a trusted masked local entry procedure, encrypt each credential with
   systemd-creds for this host into the separate sources named by the template:
   /etc/credstore.encrypted/ezra-mail-agent-key and
   `/etc/credstore.encrypted/ezra-mail-openai-runtime-key`. Use embedded credential
   names ezra-agent-key and openai-runtime-key respectively. Keep raw values out of
   arguments, environment files, command history, logs, Git and conversations.
   Host administrators can decrypt host-bound credentials; TPM protection must
   be verified separately. Do not reuse another installation's encrypted files.
8. Render [the service template](ezra-mail-cloud-mcp.service.in): replace REVISION,
   TUNNEL_ID and every APP_PRIVATE_PATH placeholder; adapt the Node path if needed.
   Add all app-data, provider-token and backup directories to InaccessiblePaths.
   The required placeholder directory deliberately keeps this template inactive
   until the operator configures it. Preserve the exact service name
   ezra-mail-cloud-mcp.service; the bridge validates its credential mount path.
9. Verify the rendered unit with systemd-analyze verify and inspect its filesystem
   isolation. Install as /etc/systemd/system/ezra-mail-cloud-mcp.service, reload
   systemd, and start exactly one tunnel client for this tunnel. Enable startup
   only after read-only checks pass. No public inbound MCP listener is required.
10. Add your private tunnel as a custom MCP server in your own ChatGPT workspace.
    Restrict access to the owner. Inspect discovered tools and account/resource
    scope before making any writes.

The bridge accepts a private mode-0400 credential or systemd's exact root-owned
named-service-user read ACL. It rejects mutable, shared or foreign credentials,
wrong release hashes, injected Node options, wrong entry paths and missing keys.
It must not gain access to the app database or provider token files. getfacl is
used only for bounded metadata inspection of the service credential.

## Verify, renew and recover

Read capabilities, both configured accounts, calendars and selected task lists
from the MAIN conversation with the workstation disconnected. Then approve
clearly labeled disposable fixtures and verify every receipt and provider result.
Follow the [action reference](../SCOPED_ACTIONS.md). Do not use real user items as
fixtures or enable unsupported actions. Test restart, expired/revoked keys,
network/TLS outages, duplicate requests and unknown-outcome reconciliation before
calling your installation fully qualified.

Keys expire independently. Review a new Ezra grant in Settings and securely replace
the server credential. Restart the one service so systemd remounts the new encrypted
credential; replacing only its source file does not refresh the running mount.
Verify scope before revoking the old grant. No automatic self-renewal is provided.

To stop access, stop/disable the service and revoke its two dedicated keys. To roll
back, select a previously verified matching bridge, manifest and profile and restart
one instance. This does not restore the database or undo provider actions. Preserve
operation IDs, receipts and uncertain locks across upgrades and rollback.
