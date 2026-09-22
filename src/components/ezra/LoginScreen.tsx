"use client";

import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { post } from "./api";
import { EZRA_MAIL_PRODUCT_VERSION } from "./version";
import styles from "./EzraMail.module.css";

export function LoginScreen(props: {
  configured: boolean;
  onAuthenticated: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/login", { password });
      props.onAuthenticated();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginPanel} aria-labelledby="login-title">
        <div className={styles.loginBrand}>
          <span className={styles.brandMark}>
            <img src="/branding/ezra-mail-logo-d4-120.png" alt="" aria-hidden="true" />
          </span>
          <div>
            <strong className={styles.brandTitle}>Ezra Mail <em className={styles.versionBadge}>v{EZRA_MAIL_PRODUCT_VERSION}</em></strong>
            <span>Private mail intelligence</span>
          </div>
        </div>
        <div className={styles.loginCopy}>
          <LockKeyhole aria-hidden="true" />
          <h1 id="login-title">Welcome back</h1>
          <p>{props.configured ? "Enter your Ezra Mail password." : "Authentication needs to be configured on the server."}</p>
        </div>
        {props.configured ? (
          <form onSubmit={submit} className={styles.loginForm}>
            <label htmlFor="ezra-password">Password</label>
            <input
              id="ezra-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
            {error ? <p className={styles.formError} role="alert">{error}</p> : null}
            <button className={styles.primaryButton} type="submit" disabled={busy || !password}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        ) : (
          <p className={styles.setupNotice}>Finish the secure first-owner setup link opened by Ezra Mail Setup. If it expired, run <code>npm run auth:bootstrap -- --origin http://127.0.0.1:3000 --transport local</code> from the Ezra Mail folder.</p>
        )}
      </section>
    </main>
  );
}
