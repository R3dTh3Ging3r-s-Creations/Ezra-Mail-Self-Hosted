import { scryptSync } from "node:crypto";

export const E2E_OWNER_PASSWORD = ["ezra", "e2e", "owner", "password"].join("-");

export function e2eOwnerPasswordHashBase64() {
  const parameters = { N: 16_384, r: 8, p: 1 };
  const salt = Buffer.from(["ezra", "e2e", "salt", "one"].join("-"));
  const derived = scryptSync(E2E_OWNER_PASSWORD, salt, 64, {
    ...parameters,
    maxmem: 32 * 1024 * 1024,
  });
  const encoded = [
    "scrypt",
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
  return Buffer.from(encoded).toString("base64");
}

export function e2eAuthSecret() {
  return Array.from({ length: 4 }, (_, index) => `e2e-${index + 1}`).join("-");
}
