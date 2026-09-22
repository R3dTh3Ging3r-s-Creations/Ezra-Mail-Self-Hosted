"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { EZRA_MAIL_PRODUCT_VERSION } from "./version";
import styles from "./EzraMail.module.css";

export function FirstOwnerSetup(props: { challenge: string }) {
  const [ownerPassword, setOwnerPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("This browser");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyStatus, setPasskeyStatus] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (ownerPassword !== confirmPassword) {
      setError("The owner passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/setup/first-owner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: props.challenge, ownerPassword, confirmPassword, deviceLabel }),
      });
      const body = await response.json() as { error?: string; recoveryKit?: { code?: string } };
      if (!response.ok || !body.recoveryKit?.code) throw new Error(body.error || "Secure setup could not be completed.");
      setRecoveryCode(body.recoveryKit.code);
      setOwnerPassword("");
      setConfirmPassword("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    if (!window.PublicKeyCredential) {
      setError("This browser does not support passkeys. You can add one later from Settings on a supported browser.");
      return;
    }
    setPasskeyBusy(true);
    setError("");
    try {
      const startResponse = await fetch("/api/auth/passkeys/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const start = await startResponse.json() as { challengeId?: string; options?: RegistrationOptionsJson; error?: string };
      if (!startResponse.ok || !start.challengeId || !start.options) throw new Error(start.error || "Passkey setup could not start.");
      const credential = await navigator.credentials.create({ publicKey: registrationOptions(start.options) }) as PublicKeyCredential | null;
      if (!credential) throw new Error("Passkey setup was cancelled.");
      const finishResponse = await fetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: start.challengeId,
          name: "First owner passkey",
          response: registrationCredentialJson(credential),
        }),
      });
      const finished = await finishResponse.json() as { error?: string };
      if (!finishResponse.ok) throw new Error(finished.error || "Passkey setup could not be completed.");
      setPasskeyStatus("Owner passkey added.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginPanel} aria-labelledby="first-owner-title">
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
          <ShieldCheck aria-hidden="true" />
          <h1 id="first-owner-title">Secure Ezra Mail</h1>
          <p>Create the private owner credential for this Ezra Mail installation.</p>
        </div>
        {recoveryCode ? (
          <section className={styles.recoveryKit} aria-label="One-time recovery material">
            <KeyRound aria-hidden="true" />
            <h2>Save this recovery code now</h2>
            <p>Store it somewhere private. Ezra Mail will not show this code again.</p>
            <code>{recoveryCode}</code>
            <p className={styles.setupHint}>Your first browser is trusted. Add a passkey now to protect rare owner-security changes.</p>
            <button className={styles.secondaryButton} type="button" disabled={passkeyBusy || Boolean(passkeyStatus)} onClick={() => void addPasskey()}>
              <KeyRound aria-hidden="true" /> {passkeyStatus || (passkeyBusy ? "Waiting for passkey..." : "Add a passkey now")}
            </button>
            {error ? <p className={styles.formError} role="alert">{error}</p> : null}
            <button className={styles.primaryButton} type="button" onClick={() => { window.location.href = "/"; }}>
              Continue to Ezra Mail
            </button>
          </section>
        ) : (
          <form onSubmit={submit} className={styles.loginForm}>
            <label htmlFor="first-owner-password">Owner password</label>
            <input
              id="first-owner-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={ownerPassword}
              onChange={(event) => setOwnerPassword(event.target.value)}
              autoFocus
            />
            <label htmlFor="first-owner-confirm">Confirm owner password</label>
            <input
              id="first-owner-confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <label htmlFor="first-owner-device">Name this device</label>
            <input
              id="first-owner-device"
              autoComplete="nickname"
              maxLength={80}
              value={deviceLabel}
              onChange={(event) => setDeviceLabel(event.target.value)}
            />
            {error ? <p className={styles.formError} role="alert">{error}</p> : null}
            <button className={styles.primaryButton} type="submit" disabled={busy || ownerPassword.length < 12 || !confirmPassword || !deviceLabel.trim()}>
              <LockKeyhole aria-hidden="true" /> {busy ? "Securing Ezra Mail..." : "Secure this Ezra Mail"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

type RegistrationOptionsJson = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};

function registrationOptions(options: RegistrationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    user: { ...options.user, id: decodeBase64Url(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  };
}

function registrationCredentialJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
      transports,
      publicKeyAlgorithm: typeof response.getPublicKeyAlgorithm === "function" ? response.getPublicKeyAlgorithm() : undefined,
    },
  };
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
