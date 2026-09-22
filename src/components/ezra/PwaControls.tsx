"use client";

import { Download, RefreshCw, Wrench } from "lucide-react";
import { usePwa } from "./PwaProvider";
import styles from "./EzraMail.module.css";

export function PwaControls() {
  const pwa = usePwa();
  const phase = pwa?.phase ?? "checking";
  const hasConnection = ["ready", "installing", "waiting"].includes(phase);
  const guidance = phase === "insecure" ? "Open Ezra over HTTPS to install it. You can keep using this web page."
    : phase === "unsupported" ? "This browser does not support the app connection. You can keep using Ezra on the web."
    : phase === "conflict" ? "Another app connection already uses this address. Ezra has left it unchanged. Review this site's app settings in your browser."
    : phase === "repaired" ? "App connection removed. Save your work, close all Ezra windows, and reopen this address to reconnect."
    : phase === "waiting" ? "Update ready. Save your work, close all Ezra windows, and reopen this address to apply it."
    : phase === "installing" ? "Checking app update"
    : phase === "ready" ? "App connection ready"
    : phase === "checking" ? "Checking app connection..." : "";

  return (
    <section className={styles.pwaPanel} aria-labelledby="pwa-heading">
      <h3 id="pwa-heading">Install Ezra Mail</h3>
      <p>Keep Ezra in its own window or on your Home Screen. Mail needs a connection; installing does not enable notifications or delivery after Ezra is closed.</p>
      {pwa?.origin ? <p className={styles.pwaOrigin}>This install belongs to {pwa.origin}. Another Ezra address needs its own install and notification permission.</p> : null}
      {pwa?.installed ? <strong>Installed on this browser</strong> : <p>Use your browser's Install app menu when available. On iPhone or iPad, open this address in Safari, then choose Share → Add to Home Screen.</p>}
      <div className={styles.pwaActions}>
        {pwa?.canInstall && !pwa.installed && phase !== "conflict" && phase !== "repaired" ? <button className={styles.secondaryButton} disabled={pwa.busy} onClick={() => void pwa.install()}><Download aria-hidden="true" /> Install Ezra Mail</button> : null}
        {hasConnection ? <button className={styles.secondaryButton} disabled={pwa?.busy} onClick={() => void pwa?.checkUpdate()}><RefreshCw aria-hidden="true" /> Check for updates</button> : null}
        {phase === "error" ? <button className={styles.secondaryButton} disabled={pwa?.busy} onClick={() => void pwa?.connect()}>Retry app connection</button> : null}
      </div>
      <div aria-live="polite"><p>{guidance}</p>{pwa?.notice ? <p>{pwa.notice}</p> : null}</div>
      {hasConnection ? <details><summary>App connection help</summary>
        <p>If opening the app fails or an update stays stuck, repair its connection. Your sign-in, saved drafts, and notification settings stay in place. Save any open work before closing Ezra.</p>
        <button className={styles.secondaryButton} disabled={pwa?.busy} onClick={() => void pwa?.repair()}><Wrench aria-hidden="true" /> Repair app connection</button>
      </details> : null}
    </section>
  );
}
