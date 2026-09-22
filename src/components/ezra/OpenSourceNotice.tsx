import styles from "./EzraMail.module.css";

const publicRepository = "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted";

export function OpenSourceNotice() {
  return (
    <section className={styles.recoveryPanel} aria-label="Open source and licensing">
      <header>
        <div>
          <h3>Open source</h3>
          <p>Ezra Mail's community edition is available under AGPL-3.0-only.</p>
        </div>
      </header>
      <div className={styles.systemActions}>
        <a className={styles.systemExportLink} href={publicRepository} target="_blank" rel="noreferrer">Public source</a>
        <a className={styles.systemExportLink} href={`${publicRepository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">AGPL-3.0-only license</a>
        <a className={styles.systemExportLink} href={`${publicRepository}/blob/main/COMMERCIAL-LICENSING.md`} target="_blank" rel="noreferrer">Commercial licensing</a>
      </div>
    </section>
  );
}
