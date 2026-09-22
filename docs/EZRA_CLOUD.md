# Ezra Cloud - Post-1.0 Architecture Brief

Date planned: 2026-08-03

## Product Boundary

Ezra Cloud is a separate hosted, multi-user product built after the private
self-hosted v1.0 release. It reuses proven provider, policy, drafting, and UI
contracts where practical, but it does not convert the single-owner SQLite
database into tenancy in place.

## Required Architecture

- User and tenant identities, email verification, passkeys/recovery, named
  devices, session management, and tenant authorization on every data path.
- Per-user OAuth state and refresh tokens encrypted with managed KMS-backed
  keys; no shared credentials or filesystem token stores.
- Managed relational storage such as Postgres, object storage for attachment
  bytes, durable queues, idempotent workers, quotas, and tenant-aware scheduling.
- Public HTTPS domain, Google production OAuth verification, Microsoft
  publisher verification, provider redirect/callback handling, and replay-safe
  state validation.
- Privacy/terms pages, consent records, retention controls, complete export and
  deletion, abuse/rate limiting, backup/restore, audit evidence, observability,
  incident response, and support tooling.
- A tenant-isolated model strategy with explicit privacy and cost boundaries;
  the private edition's single local Ollama runtime is not assumed to be a
  multi-tenant service.

## Delivery Sequence

1. Produce a threat model, tenant/data ownership model, and provider-token
   lifecycle design after private v1.0 evidence is complete.
2. Build public authentication and an empty tenant/account shell before mail
   ingestion.
3. Add one provider through the shared adapter contract, then prove isolation,
   export/deletion, backup/restore, quotas, and incident response.
4. Add additional providers, paid plans only if required, and controlled beta
   onboarding after security review.

The private/self-hosted edition remains supported and does not require the
Cloud service, public inbound ports, billing, or hosted model processing.
