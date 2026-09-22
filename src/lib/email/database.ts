import { withEmailDatabaseAccess } from "./database-access";
import { migrateMorningBriefSchema } from './morning-brief-schema';
import { migrateNotificationTelegramUpdatesSchema } from "./notification-telegram-updates-schema";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createClient, type Client, type InValue } from "@libsql/client";
import type {
  AccountStatus,
  DashboardState,
  DraftItem,
  DigestRecord,
  DigestPreview,
  InboxItem,
  LearnedPreference,
  ModelId,
  ModelBenchmarkState,
  ModelRun,
  ServiceHealth,
  TriageResult,
  UpdateStatus,
} from "./types";
import { accountPurpose, accountWorkspaceId, buildMailWorkspaces } from "./workspaces";

import { migrateNotificationTelegramSchema } from "./notification-telegram-schema";
import { migrateNotificationSetupSchema } from "./notification-setup-schema";
import { migrateNotificationScheduleSchema } from "./notification-schedule-schema";
import { migrateNotificationGovernorSchema } from "./notification-governor-schema";
import { migrateNotificationSchema } from "./notification-schema";

let clientCache: Client | undefined;
let initializedUrl: string | undefined;
let initialization: Promise<void> | undefined;

export const EMAIL_SCHEMA_VERSION = 10;

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function databaseUrl() {
  return process.env.EZRA_EMAIL_DATABASE_URL || "file:./data/ezra-mail.sqlite";
}

export function getEmailDatabasePath() {
  const url = databaseUrl();
  if (!url.startsWith("file:")) return null;
  const raw = url.replace(/^file:/, "");
  if (!raw || raw.startsWith(":")) return null;
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function ensureDirectory(url: string) {
  if (!url.startsWith("file:")) return;
  const raw = url.replace(/^file:/, "");
  if (raw.startsWith(":")) return;
  const target = path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

// Independent short-lived connections share the configured database, not client state.
export function createEmailDatabaseConnection(): Client {
  const url = databaseUrl();
  ensureDirectory(url);
  return createClient({ url });
}

export function getEmailClient() {
  const url = databaseUrl();
  if (!clientCache || initializedUrl !== url) {
    ensureDirectory(url);
    clientCache = createClient({ url });
    initializedUrl = url;
    initialization = undefined;
  }
  return clientCache;
}

export function configureEmailDatabaseForTests(url: string): string {
  clientCache?.close();
  const raw = url.replace(/^file:/, "");
  const relative = raw.replace(/^\.\//, "");
  const testUrl = raw && !path.isAbsolute(raw) && !raw.startsWith(":") && !relative.startsWith("data/tests/")
    ? `file:./data/tests/${relative}`
    : url;
  ensureDirectory(testUrl);
  process.env.EZRA_EMAIL_DATABASE_URL = testUrl;
  clientCache = undefined;
  initializedUrl = undefined;
  initialization = undefined;
  return testUrl;
}

export async function closeEmailDatabaseForTests() {
  await clientCache?.close();
  clientCache = undefined;
  initializedUrl = undefined;
  initialization = undefined;
}

export async function ensureEmailDatabase() {
  const runtime = getEmailClient();
  if (initialization) return initialization;
  initialization = initializeWithRetry(runtime, databaseUrl()).catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

async function configureConnection(client: Client) {
  await client.execute(`PRAGMA busy_timeout = 10000`);
  await client.execute(`PRAGMA foreign_keys = ON`);
}

async function initializeWithRetry(runtime: Client, url: string) {
  await configureConnection(runtime);
  // A failed native statement can outlive rollback. File initialization owns its
  // connection so retry never reuses that state or closes a runtime consumer.
  // Memory and remote clients retain their existing connection semantics.
  const ownsConnection = /^file:/i.test(url) && !/^file::memory:(?:\?|$)/i.test(url);
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const client = ownsConnection ? createClient({ url }) : runtime;
      try {
        await initialize(client);
        return;
      } finally {
        if (ownsConnection) client.close();
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/SQLITE_BUSY|database is locked/i.test(message) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function initialize(client: Client) {
  await configureConnection(client);
  await client.execute(`PRAGMA journal_mode = WAL`);
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS email_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        last_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS provider_account_credentials (
        account_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_backend TEXT NOT NULL,
        credential_reference TEXT NOT NULL,
        access TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS provider_connection_settings (
        account_id TEXT PRIMARY KEY,
        provider_preset TEXT,
        server_config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS account_profile_settings (
        account_id TEXT PRIMARY KEY,
        purpose_label TEXT NOT NULL,
        sync_range_days INTEGER NOT NULL DEFAULT 2,
        color TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS account_writing_settings (
        account_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL DEFAULT '',
        signature_enabled INTEGER NOT NULL DEFAULT 0,
        default_tone TEXT NOT NULL DEFAULT 'professional',
        preferred_length TEXT NOT NULL DEFAULT 'balanced',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS sender_content_preferences (
        account_id TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        allow_remote_images INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, sender_email),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS email_messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        history_id TEXT,
        sender_name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        snippet TEXT NOT NULL,
        gmail_url TEXT NOT NULL,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        gmail_labels TEXT NOT NULL DEFAULT '[]',
        is_unread INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_flagged INTEGER NOT NULL DEFAULT 0,
        organization_confirmed_at TEXT,
        ingest_source TEXT NOT NULL DEFAULT 'live',
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, external_message_id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS message_content_cache (
        message_id TEXT PRIMARY KEY,
        provider_revision TEXT,
        plain_text TEXT NOT NULL,
        sanitized_html TEXT,
        content_hash TEXT NOT NULL,
        remote_image_count INTEGER NOT NULL DEFAULT 0,
        tracking_pixel_count INTEGER NOT NULL DEFAULT 0,
        is_truncated INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        provider_attachment_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        is_inline INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_id, provider_attachment_id),
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_attachments_message
        ON message_attachments(message_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS triage_decisions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        model TEXT NOT NULL,
        attention TEXT NOT NULL,
        urgency INTEGER NOT NULL,
        confidence REAL NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        needs_reply INTEGER NOT NULL,
        deadline TEXT,
        draft_reply TEXT,
        injection_flags TEXT NOT NULL DEFAULT '[]',
        critical_reason TEXT,
        user_corrected_attention TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_triage_message_created
        ON triage_decisions(message_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        kind TEXT NOT NULL,
        external_id TEXT,
        status TEXT NOT NULL,
        sent_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS notification_decisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_notification_decisions_decided
        ON notification_decisions(decided_at DESC)`,
      `CREATE TABLE IF NOT EXISTS email_digests (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        scheduled_for TEXT,
        external_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS email_digest_items (
        digest_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        summary_snapshot TEXT NOT NULL,
        recommendation_snapshot TEXT NOT NULL,
        PRIMARY KEY(digest_id, message_id),
        FOREIGN KEY(digest_id) REFERENCES email_digests(id),
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS context_notes (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS reply_drafts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS send_approvals (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        draft_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES reply_drafts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS outgoing_drafts (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_message_id TEXT,
        reply_mode TEXT,
        legacy_reply_draft_id TEXT,
        account_id TEXT NOT NULL,
        from_email TEXT NOT NULL,
        to_recipients TEXT NOT NULL DEFAULT '[]',
        cc_recipients TEXT NOT NULL DEFAULT '[]',
        bcc_recipients TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        approval_snapshot TEXT,
        provider_message_id TEXT,
        provider_draft_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id),
        FOREIGN KEY(source_message_id) REFERENCES email_messages(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outgoing_drafts_account_status
        ON outgoing_drafts(account_id, status, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS outgoing_draft_attachments (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 1,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES outgoing_drafts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outgoing_draft_attachments_draft
        ON outgoing_draft_attachments(draft_id, removed_at, created_at)`,
      `CREATE TABLE IF NOT EXISTS outgoing_message_attempts (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provider_message_id TEXT,
        provider_draft_id TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(draft_id) REFERENCES outgoing_drafts(id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outgoing_message_attempts_draft_time
        ON outgoing_message_attempts(draft_id, started_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feedback_events (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        draft_id TEXT,
        event_type TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS learned_preferences (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        action TEXT NOT NULL,
        weight REAL NOT NULL,
        evidence_count INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(kind, account_id, pattern, action),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS model_runs (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        classification TEXT,
        duration_ms INTEGER NOT NULL,
        memory_mb REAL,
        input_chars INTEGER NOT NULL,
        output_chars INTEGER NOT NULL,
        valid INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS model_benchmarks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        model TEXT NOT NULL,
        expected_attention TEXT NOT NULL,
        actual_attention TEXT NOT NULL,
        expected_reply INTEGER NOT NULL,
        actual_reply INTEGER NOT NULL,
        expected_injection INTEGER NOT NULL,
        actual_injection INTEGER NOT NULL,
        score REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        memory_mb REAL,
        valid INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, case_id, model)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_model_benchmarks_run
        ON model_benchmarks(run_id, model)`,
      `CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS mailbox_sweeps (
        account_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        query TEXT NOT NULL,
        page_token TEXT,
        exhausted INTEGER NOT NULL DEFAULT 0,
        pages_scanned INTEGER NOT NULL DEFAULT 0,
        discovered_count INTEGER NOT NULL DEFAULT 0,
        rule_handled_count INTEGER NOT NULL DEFAULT 0,
        model_handled_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS maintenance_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        approved_at TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, sender_email, action),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS maintenance_actions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        details TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        executed_at TEXT,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS daily_briefs (
        id TEXT PRIMARY KEY,
        brief_date TEXT NOT NULL UNIQUE,
        quiet_reviewed INTEGER NOT NULL DEFAULT 0,
        generated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS brief_topics (
        id TEXT PRIMARY KEY,
        brief_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(brief_id, message_id),
        FOREIGN KEY(brief_id) REFERENCES daily_briefs(id),
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_brief_topics_brief
        ON brief_topics(brief_id, position)`,
      `CREATE TABLE IF NOT EXISTS brief_item_memory (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_key TEXT NOT NULL,
        source_account_id TEXT,
        source_revision_at TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        target_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        completed_at TEXT,
        dismissed_at TEXT,
        restored_at TEXT,
        completion_evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, source_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_brief_item_memory_workspace_state
        ON brief_item_memory(workspace_id, state, updated_at)`,
      `CREATE TABLE IF NOT EXISTS reply_completion_evidence (
        id TEXT PRIMARY KEY,
        brief_item_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('gmail', 'microsoft')),
        provider_message_id TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        provider_sent_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(account_id, provider, provider_message_id),
        FOREIGN KEY(brief_item_id) REFERENCES brief_item_memory(id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reply_completion_evidence_brief_item
        ON reply_completion_evidence(brief_item_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_reply_completion_evidence_source
        ON reply_completion_evidence(source_key, provider_sent_at)`,
      `CREATE TABLE IF NOT EXISTS sent_evidence_sync_state (
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('gmail', 'microsoft')),
        status TEXT NOT NULL CHECK(status IN ('current', 'truncated', 'error')),
        last_attempted_at TEXT NOT NULL,
        last_successful_at TEXT,
        last_error_code TEXT,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, provider),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS provider_search_results (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        searched_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(query, account_id, message_id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id),
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS mail_actions (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        message_ids TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        details TEXT NOT NULL DEFAULT '{}',
        undo_data TEXT,
        undo_status TEXT,
        provider_metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        executed_at TEXT,
        undone_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS email_capabilities (
        message_id TEXT PRIMARY KEY,
        one_click_unsubscribe INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(message_id) REFERENCES email_messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS account_integrations (
        account_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        provider TEXT NOT NULL,
        access TEXT NOT NULL,
        status TEXT NOT NULL,
        last_connected_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, feature),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS contact_index (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        note TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, email, source),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_contact_index_account_email
        ON contact_index(account_id, email)`,
      `CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        definition_json TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_saved_views_workspace_order
        ON saved_views(workspace_id, is_enabled, sort_order, label)`,
      `CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        calendar_name TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        is_all_day INTEGER NOT NULL DEFAULT 0,
        timezone TEXT,
        status TEXT NOT NULL,
        visibility TEXT,
        is_busy INTEGER NOT NULL DEFAULT 1,
        organizer_name TEXT,
        organizer_email TEXT,
        attendees TEXT NOT NULL DEFAULT '[]',
        web_link TEXT,
        provider_updated_at TEXT,
        synced_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, external_event_id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_calendar_events_account_start
        ON calendar_events(account_id, starts_at)`,
      `CREATE TABLE IF NOT EXISTS calendar_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        is_all_day INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL,
        attendees TEXT NOT NULL DEFAULT '[]',
        reminder_minutes INTEGER,
        is_busy INTEGER NOT NULL DEFAULT 1,
        privacy TEXT NOT NULL DEFAULT 'default',
        send_updates INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        provider_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_calendar_drafts_account_status
        ON calendar_drafts(account_id, status, starts_at)`,
      `CREATE TABLE IF NOT EXISTS calendar_sync_state (
        account_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        status TEXT NOT NULL,
        last_sync_at TEXT,
        last_error TEXT,
        range_from TEXT,
        range_to TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, calendar_id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        device_id TEXT,
        revoked_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_sessions_token
        ON auth_sessions(token_hash, revoked_at)`,
      `CREATE TABLE IF NOT EXISTS auth_login_attempts (
        id TEXT PRIMARY KEY,
        ip_address TEXT NOT NULL,
        succeeded INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_time
        ON auth_login_attempts(ip_address, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS trusted_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        last_user_agent TEXT,
        last_ip_address TEXT,
        revoked_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_devices_token
        ON trusted_devices(token_hash, revoked_at)`,
      `CREATE TABLE IF NOT EXISTS owner_passkeys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '[]',
        device_type TEXT,
        backed_up INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        challenge TEXT NOT NULL,
        action TEXT NOT NULL,
        device_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry
        ON auth_challenges(expires_at, used_at)`,
      `CREATE TABLE IF NOT EXISTS first_owner_setup (
        id TEXT PRIMARY KEY,
        challenge_hash TEXT NOT NULL UNIQUE,
        recovery_code_hash TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        transport TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        used_at TEXT,
        cancelled_at TEXT,
        cancellation_reason TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_first_owner_setup_active
        ON first_owner_setup(expires_at, used_at, cancelled_at)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS email_message_fts USING fts5(
        message_id UNINDEXED,
        sender_name,
        sender_email,
        subject,
        snippet,
        summary,
        category,
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
    ],
    "write",
  );

  const modelRunColumns = await client.execute(`PRAGMA table_info(model_runs)`);
  const modelRunColumnNames = new Set(modelRunColumns.rows.map((row) => String(row.name)));
  if (!modelRunColumnNames.has("classification")) {
    await client.execute(`ALTER TABLE model_runs ADD COLUMN classification TEXT`);
  }
  if (!modelRunColumnNames.has("memory_mb")) {
    await client.execute(`ALTER TABLE model_runs ADD COLUMN memory_mb REAL`);
  }
  const authSessionColumns = await client.execute(`PRAGMA table_info(auth_sessions)`);
  const authSessionColumnNames = new Set(authSessionColumns.rows.map((row) => String(row.name)));
  if (!authSessionColumnNames.has("device_id")) {
    await client.execute(`ALTER TABLE auth_sessions ADD COLUMN device_id TEXT`);
  }
  const messageColumns = await client.execute(`PRAGMA table_info(email_messages)`);
  const messageColumnNames = new Set(messageColumns.rows.map((row) => String(row.name)));
  if (!messageColumnNames.has("ingest_source")) {
    await client.execute(
      `ALTER TABLE email_messages ADD COLUMN ingest_source TEXT NOT NULL DEFAULT 'live'`,
    );
  }
  if (!messageColumnNames.has("is_unread")) {
    await client.execute(
      `ALTER TABLE email_messages ADD COLUMN is_unread INTEGER NOT NULL DEFAULT 0`,
    );
    await client.execute(
      `UPDATE email_messages SET is_unread = 1 WHERE ingest_source = 'backlog'`,
    );
  }
  if (!messageColumnNames.has("gmail_labels")) {
    await client.execute(
      `ALTER TABLE email_messages ADD COLUMN gmail_labels TEXT NOT NULL DEFAULT '[]'`,
    );
  }
  if (!messageColumnNames.has("is_pinned")) {
    await client.execute(`ALTER TABLE email_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!messageColumnNames.has("is_flagged")) {
    await client.execute(`ALTER TABLE email_messages ADD COLUMN is_flagged INTEGER NOT NULL DEFAULT 0`);
  }
  if (!messageColumnNames.has("organization_confirmed_at")) {
    await client.execute(`ALTER TABLE email_messages ADD COLUMN organization_confirmed_at TEXT`);
  }

  const profileColumns = await client.execute(`PRAGMA table_info(account_profile_settings)`);
  if (!profileColumns.rows.some((row) => String(row.name) === "sync_range_days")) {
    await client.execute(`ALTER TABLE account_profile_settings ADD COLUMN sync_range_days INTEGER NOT NULL DEFAULT 2`);
  }
  const outgoingDraftColumns = await client.execute(`PRAGMA table_info(outgoing_drafts)`);
  const outgoingDraftColumnNames = new Set(outgoingDraftColumns.rows.map((row) => String(row.name)));
  if (!outgoingDraftColumnNames.has("reply_mode")) {
    await client.execute(`ALTER TABLE outgoing_drafts ADD COLUMN reply_mode TEXT`);
  }
  if (!outgoingDraftColumnNames.has("legacy_reply_draft_id")) {
    await client.execute(`ALTER TABLE outgoing_drafts ADD COLUMN legacy_reply_draft_id TEXT`);
  }
  if (!outgoingDraftColumnNames.has("provider_draft_id")) {
    await client.execute(`ALTER TABLE outgoing_drafts ADD COLUMN provider_draft_id TEXT`);
  }
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_outgoing_drafts_legacy_reply
      ON outgoing_drafts(legacy_reply_draft_id) WHERE legacy_reply_draft_id IS NOT NULL`,
  );

  const outgoingAttemptColumns = await client.execute(`PRAGMA table_info(outgoing_message_attempts)`);
  const outgoingAttemptColumnNames = new Set(outgoingAttemptColumns.rows.map((row) => String(row.name)));
  if (!outgoingAttemptColumnNames.has("provider_draft_id")) {
    await client.execute(`ALTER TABLE outgoing_message_attempts ADD COLUMN provider_draft_id TEXT`);
  }
  await migrateLegacyReplyDrafts(client);

  const maintenanceColumns = await client.execute(`PRAGMA table_info(maintenance_actions)`);
  const maintenanceColumnNames = new Set(
    maintenanceColumns.rows.map((row) => String(row.name)),
  );
  if (!maintenanceColumnNames.has("undo_data")) {
    await client.execute(`ALTER TABLE maintenance_actions ADD COLUMN undo_data TEXT`);
  }
  if (!maintenanceColumnNames.has("undo_status")) {
    await client.execute(`ALTER TABLE maintenance_actions ADD COLUMN undo_status TEXT`);
  }
  if (!maintenanceColumnNames.has("provider_metadata")) {
    await client.execute(
      `ALTER TABLE maintenance_actions ADD COLUMN provider_metadata TEXT NOT NULL DEFAULT '{}'`,
    );
  }
  const calendarSyncColumns = await client.execute(`PRAGMA table_info(calendar_sync_state)`);
  const calendarSyncColumnNames = new Set(calendarSyncColumns.rows.map((row) => String(row.name)));
  if (!calendarSyncColumnNames.has("range_from")) {
    await client.execute(`ALTER TABLE calendar_sync_state ADD COLUMN range_from TEXT`);
  }
  if (!calendarSyncColumnNames.has("range_to")) {
    await client.execute(`ALTER TABLE calendar_sync_state ADD COLUMN range_to TEXT`);
  }
  await migrateLearnedPreferencesAccountScope(client);
  await migrateLegacyProviderWorkspaceSelections(client);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_learned_preferences_account_sender
      ON learned_preferences(account_id, kind, pattern, enabled)`,
  );

  await client.execute(
    `INSERT INTO email_message_fts
      (message_id, sender_name, sender_email, subject, snippet, summary, category)
     SELECT m.id, m.sender_name, m.sender_email, m.subject, m.snippet,
       COALESCE((SELECT td.summary FROM triage_decisions td
         WHERE td.message_id = m.id ORDER BY td.created_at DESC LIMIT 1), ''),
       COALESCE((SELECT td.category FROM triage_decisions td
         WHERE td.message_id = m.id ORDER BY td.created_at DESC LIMIT 1), '')
     FROM email_messages m
     WHERE NOT EXISTS (
       SELECT 1 FROM email_message_fts f WHERE f.message_id = m.id
     )`,
  );

  const defaults: Record<string, string> = {
    active_model: "qwen3:8b-maxctx",
    timezone: "America/Chicago",
    poll_minutes: "5",
    digest_times: JSON.stringify(["08:30", "16:30"]),
    quiet_start: "22:00",
    quiet_end: "07:30",
  };
  for (const [key, value] of Object.entries(defaults)) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      args: [key, value, nowIso()],
    });
  }

  const notificationPolicy = await client.execute(
    `SELECT value FROM settings WHERE key = 'notification_policy_version'`,
  );
  if (!notificationPolicy.rows.length) {
    await client.execute({
      sql: `UPDATE settings SET value = ?, updated_at = ?
        WHERE key = 'digest_times' AND value = ?`,
      args: [JSON.stringify(["08:30", "16:30"]), nowIso(), JSON.stringify(["08:00", "16:30"])],
    });
    await client.execute({
      sql: `UPDATE settings SET value = '07:30', updated_at = ?
        WHERE key = 'quiet_end' AND value = '07:00'`,
      args: [nowIso()],
    });
    await client.execute({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES ('notification_policy_version', '1', ?)`,
      args: [nowIso()],
    });
  }
  await migrateLegacyInterruptNotifications(client);
  await migrateBriefEvidenceAndCalendarDates(client);
  await migrateNotificationSchema(client);
  await migrateNotificationGovernorSchema(client);
  await migrateNotificationScheduleSchema(client);
  await migrateNotificationSetupSchema(client);
  await migrateNotificationTelegramSchema(client);
  await migrateNotificationTelegramUpdatesSchema(client);
  await migrateMorningBriefSchema(client);
}

async function migrateBriefEvidenceAndCalendarDates(client: Client) {
  const columns = new Set((await client.execute("PRAGMA table_info(calendar_events)")).rows.map((row) => String(row.name)));
  const statements: Array<string | { sql: string; args: InValue[] }> = [
    `CREATE TABLE IF NOT EXISTS reply_completion_evidence_links (
      id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      brief_item_id TEXT NOT NULL,
      source_revision_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(evidence_id, brief_item_id),
      FOREIGN KEY(evidence_id) REFERENCES reply_completion_evidence(id),
      FOREIGN KEY(brief_item_id) REFERENCES brief_item_memory(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reply_completion_evidence_links_item
      ON reply_completion_evidence_links(brief_item_id, created_at)`,
  ];
  if (!columns.has("start_date")) statements.push("ALTER TABLE calendar_events ADD COLUMN start_date TEXT");
  if (!columns.has("end_date")) statements.push("ALTER TABLE calendar_events ADD COLUMN end_date TEXT");
  const legacy = await client.execute(`SELECT e.*, m.source_revision_at, m.target_json
    FROM reply_completion_evidence e
    JOIN brief_item_memory m ON m.id = e.brief_item_id
      AND m.source_type = 'mail_thread' AND m.source_key = e.source_key
      AND m.source_account_id = e.account_id
    JOIN email_accounts a ON a.id = e.account_id AND a.provider = e.provider`);
  for (const row of legacy.rows) {
    let snapshot: { provider?: unknown; providerThreadId?: unknown };
    try { snapshot = JSON.parse(String(row.target_json)); } catch { continue; }
    if (!snapshot || snapshot.provider !== row.provider || snapshot.providerThreadId !== row.provider_thread_id) continue;
    if (![row.provider_message_id, row.provider_thread_id, row.source_key].every((value) => typeof value === "string" && value.trim())) continue;
    const revision = Date.parse(String(row.source_revision_at));
    const sent = Date.parse(String(row.provider_sent_at));
    const observed = Date.parse(String(row.observed_at));
    if (![revision, sent, observed, Date.parse(String(row.created_at))].every(Number.isFinite) || !(revision < sent && sent <= observed)) continue;
    const linkId = `reply_link_${createHash("sha256").update(JSON.stringify([row.id, row.brief_item_id])).digest("hex")}`;
    statements.push({
      sql: `INSERT INTO reply_completion_evidence_links (id, evidence_id, brief_item_id, source_revision_at, created_at)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM reply_completion_evidence e
          JOIN brief_item_memory m ON m.id = e.brief_item_id
            AND m.source_type = 'mail_thread' AND m.source_key = e.source_key
            AND m.source_account_id = e.account_id AND m.source_revision_at = ?
            AND m.target_json = ?
          JOIN email_accounts a ON a.id = e.account_id AND a.provider = e.provider
          WHERE e.id = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM reply_completion_evidence_links WHERE evidence_id = ? AND brief_item_id = ?
        )`,
      args: [linkId, row.id, row.brief_item_id, row.source_revision_at, row.created_at, row.source_revision_at, row.target_json, row.id, row.id, row.brief_item_id],
    });
  }
  // Commit the version only with every additive migration and validated backfill.
  const version = Number((await client.execute("PRAGMA user_version")).rows[0].user_version);
  if (version < 3) statements.push("PRAGMA user_version = 3");
  await client.batch(statements, "write");
}

async function migrateLegacyInterruptNotifications(client: Client) {
  const legacy = await client.execute(
    `SELECT message_id, MIN(created_at) AS decided_at
     FROM notifications
     WHERE kind = 'interrupt'
     GROUP BY message_id
     ORDER BY MIN(created_at), message_id`,
  );
  for (const row of legacy.rows) {
    const messageId = String(row.message_id);
    const decisionId = `decision_${createHash("sha256")
      .update(`ezra-notification-decision-v1:${messageId}`)
      .digest("hex")}`;
    const reason = "Backfilled from legacy interrupt notification history.";
    const decidedAt = String(row.decided_at);
    const [inserted] = await client.batch([
      {
        sql: `INSERT INTO notification_decisions (id, message_id, reason, decided_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(message_id) DO NOTHING`,
        args: [decisionId, messageId, reason, decidedAt],
      },
      {
        sql: `INSERT INTO audit_logs
          (id, action, actor, target_type, target_id, metadata, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`,
        args: [
          newId("audit"),
          "notification.decision.backfilled",
          "system",
          "notification_decision",
          decisionId,
          JSON.stringify({ decisionId, messageId, reason, decidedAt }),
          nowIso(),
        ],
      },
    ], "write");
    if (inserted.rowsAffected !== 1) continue;
  }
}

async function migrateLearnedPreferencesAccountScope(client: Client) {
  const columns = await client.execute(`PRAGMA table_info(learned_preferences)`);
  const columnNames = new Set(columns.rows.map((row) => String(row.name)));
  if (columnNames.has("account_id")) return;

  const gmailAccounts = await client.execute(
    `SELECT id FROM email_accounts WHERE provider = 'gmail' ORDER BY created_at, id`,
  );
  const migrationAccountId =
    gmailAccounts.rows.length === 1 ? String(gmailAccounts.rows[0].id) : null;

  await client.execute(`ALTER TABLE learned_preferences RENAME TO learned_preferences_legacy`);
  await client.execute(
    `CREATE TABLE learned_preferences (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      kind TEXT NOT NULL,
      pattern TEXT NOT NULL,
      action TEXT NOT NULL,
      weight REAL NOT NULL,
      evidence_count INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, account_id, pattern, action),
      FOREIGN KEY(account_id) REFERENCES email_accounts(id)
    )`,
  );
  await client.execute({
    sql: `INSERT INTO learned_preferences
        (id, account_id, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at)
       SELECT id, ?, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at
       FROM learned_preferences_legacy`,
    args: [migrationAccountId],
  });
  await client.execute(`DROP TABLE learned_preferences_legacy`);
}

async function migrateLegacyProviderWorkspaceSelections(client: Client) {
  const accounts = await client.execute(
    `SELECT id, provider
     FROM email_accounts
     WHERE status <> 'disabled'
     ORDER BY provider, created_at, id`,
  );
  for (const provider of ["gmail", "microsoft"] as const) {
    const matches = accounts.rows.filter((row) => String(row.provider) === provider);
    if (matches.length !== 1) continue;
    const legacyWorkspaceId = provider === "gmail" ? "workspace:gmail" : "workspace:microsoft";
    await client.execute({
      sql: `UPDATE saved_views SET workspace_id = ? WHERE workspace_id = ?`,
      args: [accountWorkspaceId(provider, String(matches[0].id)), legacyWorkspaceId],
    });
  }
}

async function migrateLegacyReplyDrafts(client: Client) {
  const rows = await client.execute(
    `SELECT d.id, d.message_id, d.content, d.version, d.created_at, d.updated_at,
      m.subject, m.sender_name, m.sender_email, m.account_id,
      a.email AS account_email
     FROM reply_drafts d
     JOIN email_messages m ON m.id = d.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE d.status IN ('draft', 'awaiting_approval', 'approved')
       AND a.provider = 'microsoft'
       AND NOT EXISTS (
         SELECT 1 FROM outgoing_drafts od WHERE od.legacy_reply_draft_id = d.id
       )
     ORDER BY d.created_at, d.id`,
  );
  for (const row of rows.rows) {
    const recipient = {
      name: String(row.sender_name || "").trim() || null,
      email: String(row.sender_email).trim().toLowerCase(),
    };
    const to = [recipient];
    const subject = /^re:/i.test(String(row.subject)) ? String(row.subject) : `Re: ${String(row.subject)}`;
    const contentHash = createHash("sha256")
      .update(JSON.stringify({
        sourceType: "reply",
        sourceMessageId: String(row.message_id),
        replyMode: "sender",
        fromEmail: String(row.account_email).toLowerCase(),
        to,
        cc: [],
        bcc: [],
        subject,
        body: String(row.content),
        attachments: [],
      }))
      .digest("hex");
    await client.execute({
      sql: `INSERT OR IGNORE INTO outgoing_drafts
        (id, source_type, source_message_id, reply_mode, legacy_reply_draft_id,
         account_id, from_email, to_recipients, cc_recipients, bcc_recipients,
         subject, body, content_hash, version, status, created_at, updated_at)
       VALUES (?, 'reply', ?, 'sender', ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, 'draft', ?, ?)`,
      args: [
        newId("outdraft"),
        String(row.message_id),
        String(row.id),
        String(row.account_id),
        String(row.account_email),
        JSON.stringify(to),
        subject,
        String(row.content),
        contentHash,
        Number(row.version || 1),
        String(row.created_at),
        String(row.updated_at),
      ],
    });
  }
}

export async function execute(sql: string, args: InValue[] = []) {
  await ensureEmailDatabase();
  return withEmailDatabaseAccess(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await getEmailClient().execute({ sql, args });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/SQLITE_BUSY|database is locked/i.test(message) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
  });
}

/** Atomic batch on the runtime connection, serialized with owned transactions. */
export async function executeBatch(...args: Parameters<Client["batch"]>) {
  await ensureEmailDatabase();
  return withEmailDatabaseAccess(() => getEmailClient().batch(...args));
}

export async function getSetting(key: string) {
  const result = await execute(`SELECT value FROM settings WHERE key = ?`, [key]);
  return result.rows[0]?.value ? String(result.rows[0].value) : null;
}

export async function setSetting(key: string, value: string) {
  await execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

export async function syncMessageSearchIndex(messageId: string) {
  await execute(`DELETE FROM email_message_fts WHERE message_id = ?`, [messageId]);
  await execute(
    `INSERT INTO email_message_fts
      (message_id, sender_name, sender_email, subject, snippet, summary, category)
     SELECT m.id, m.sender_name, m.sender_email, m.subject, m.snippet,
       COALESCE((SELECT td.summary FROM triage_decisions td
         WHERE td.message_id = m.id ORDER BY td.created_at DESC LIMIT 1), ''),
       COALESCE((SELECT td.category FROM triage_decisions td
         WHERE td.message_id = m.id ORDER BY td.created_at DESC LIMIT 1), '')
     FROM email_messages m WHERE m.id = ?`,
    [messageId],
  );
}

export async function audit(
  action: string,
  actor: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) {
  await execute(
    `INSERT INTO audit_logs
      (id, action, actor, target_type, target_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("audit"), action, actor, targetType, targetId, JSON.stringify(metadata), nowIso()],
  );
}

export async function upsertAccount(input: {
  email: string;
  label?: string;
  provider?: AccountStatus["provider"];
  status?: AccountStatus["status"];
}) {
  const existing = await execute(`SELECT id FROM email_accounts WHERE email = ?`, [input.email]);
  const id = existing.rows[0]?.id ? String(existing.rows[0].id) : newId("acct");
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
      provider = excluded.provider, label = excluded.label,
      status = excluded.status, updated_at = excluded.updated_at`,
    [
      id,
      input.provider || "gmail",
      input.email,
      input.label || input.email,
      input.status || "connected",
      now,
      now,
    ],
  );
  return id;
}

export async function setServiceState(key: string, value: string) {
  await execute(
    `INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

export async function getServiceState(key: string) {
  const result = await execute(`SELECT value FROM service_state WHERE key = ?`, [key]);
  return result.rows[0]?.value === undefined ? null : String(result.rows[0].value);
}

export async function recordModelRun(input: {
  messageId?: string | null;
  model: string;
  purpose: string;
  classification?: string | null;
  durationMs: number;
  memoryMb?: number | null;
  inputChars: number;
  outputChars: number;
  valid: boolean;
  error?: string | null;
}) {
  await execute(
    `INSERT INTO model_runs
      (id, message_id, model, purpose, classification, duration_ms, memory_mb, input_chars,
       output_chars, valid, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("run"),
      input.messageId || null,
      input.model,
      input.purpose,
      input.classification || null,
      input.durationMs,
      input.memoryMb || null,
      input.inputChars,
      input.outputChars,
      input.valid ? 1 : 0,
      input.error || null,
      nowIso(),
    ],
  );
}

export async function recordModelBenchmark(input: {
  runId: string;
  caseId: string;
  model: ModelId;
  expectedAttention: string;
  actualAttention: string;
  expectedReply: boolean;
  actualReply: boolean;
  expectedInjection: boolean;
  actualInjection: boolean;
  score: number;
  durationMs: number;
  memoryMb?: number | null;
  valid: boolean;
  error?: string | null;
}) {
  await execute(
    `INSERT INTO model_benchmarks
      (id, run_id, case_id, model, expected_attention, actual_attention,
       expected_reply, actual_reply, expected_injection, actual_injection,
       score, duration_ms, memory_mb, valid, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, case_id, model) DO UPDATE SET
       actual_attention = excluded.actual_attention,
       actual_reply = excluded.actual_reply,
       actual_injection = excluded.actual_injection,
       score = excluded.score,
       duration_ms = excluded.duration_ms,
       memory_mb = excluded.memory_mb,
       valid = excluded.valid,
       error = excluded.error,
       created_at = excluded.created_at`,
    [
      newId("benchmark"),
      input.runId,
      input.caseId,
      input.model,
      input.expectedAttention,
      input.actualAttention,
      input.expectedReply ? 1 : 0,
      input.actualReply ? 1 : 0,
      input.expectedInjection ? 1 : 0,
      input.actualInjection ? 1 : 0,
      input.score,
      input.durationMs,
      input.memoryMb || null,
      input.valid ? 1 : 0,
      input.error || null,
      nowIso(),
    ],
  );
}

export async function getDashboardState(
  health: ServiceHealth,
  updates: UpdateStatus = {
    checkedAt: nowIso(),
    app: {
      currentVersion: "unknown",
      commit: null,
      remoteConfigured: false,
      latestVersion: null,
      updateAvailable: false,
    },
    ollama: {
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
    },
    models: [],
  },
): Promise<DashboardState> {
  await ensureEmailDatabase();
  const [
    messageRows,
    mailboxRows,
    digestCandidateRows,
    digestHistoryRows,
    draftRows,
    preferenceRows,
    modelRows,
    accountRows,
    settings,
    sweepRows,
    backlogQueueRows,
    attentionCountRows,
    maintenanceCountRows,
    maintenanceRows,
    benchmarkRows,
    benchmarkStateRows,
  ] =
    await Promise.all([
      execute(
        `SELECT m.*, a.label AS account_label, a.provider AS account_provider,
          COALESCE(t.user_corrected_attention, t.attention) AS attention,
          t.urgency, t.confidence, t.category, t.summary, t.reason,
          t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
          (SELECT sent_at FROM notifications n WHERE n.message_id = m.id AND n.status = 'sent'
           ORDER BY n.created_at DESC LIMIT 1) AS notified_at
         FROM email_messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
         ORDER BY
           CASE
             WHEN COALESCE(t.user_corrected_attention, t.attention) = 'interrupt' THEN 0
             WHEN COALESCE(t.user_corrected_attention, t.attention) IS NULL THEN 1
             WHEN COALESCE(t.user_corrected_attention, t.attention) = 'digest' THEN 2
             ELSE 3
           END,
           CASE WHEN COALESCE(t.user_corrected_attention, t.attention) = 'interrupt'
             THEN COALESCE(t.urgency, 0) ELSE 0 END DESC,
           CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END,
           t.deadline ASC,
           m.received_at DESC
         LIMIT 100`,
      ),
      execute(
        `SELECT m.*, a.label AS account_label, a.provider AS account_provider,
          COALESCE(t.user_corrected_attention, t.attention) AS attention,
          t.urgency, t.confidence, t.category, t.summary, t.reason,
          t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
          (SELECT sent_at FROM notifications n WHERE n.message_id = m.id AND n.status = 'sent'
           ORDER BY n.created_at DESC LIMIT 1) AS notified_at
         FROM email_messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         ORDER BY m.received_at DESC
         LIMIT 250`,
      ),
      execute(
        `SELECT m.*, a.label AS account_label, a.provider AS account_provider,
          COALESCE(t.user_corrected_attention, t.attention) AS attention,
          t.urgency, t.confidence, t.category, t.summary, t.reason,
          t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
          (SELECT sent_at FROM notifications n WHERE n.message_id = m.id AND n.status = 'sent'
           ORDER BY n.created_at DESC LIMIT 1) AS notified_at
         FROM email_messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
           AND COALESCE(t.user_corrected_attention, t.attention) = 'digest'
         ORDER BY
           COALESCE(t.urgency, 0) DESC,
           CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END,
           t.deadline ASC,
           m.received_at DESC
         LIMIT 50`,
      ),
      execute(
        `SELECT d.id AS digest_id, d.label AS digest_label, d.channel AS digest_channel,
          d.status AS digest_status, d.item_count AS digest_item_count,
          d.scheduled_for AS digest_scheduled_for, d.created_at AS digest_created_at,
          d.sent_at AS digest_sent_at, d.error AS digest_error,
          di.position AS digest_position, di.summary_snapshot, di.recommendation_snapshot,
          m.*, a.label AS account_label, a.provider AS account_provider,
          COALESCE(t.user_corrected_attention, t.attention) AS attention,
          t.urgency, t.confidence, t.category, t.summary, t.reason,
          t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
          (SELECT sent_at FROM notifications n WHERE n.message_id = m.id AND n.status = 'sent'
           ORDER BY n.created_at DESC LIMIT 1) AS notified_at
         FROM email_digests d
         LEFT JOIN email_digest_items di ON di.digest_id = d.id
         LEFT JOIN email_messages m ON m.id = di.message_id
         LEFT JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE d.id IN (SELECT id FROM email_digests ORDER BY created_at DESC LIMIT 20)
         ORDER BY d.created_at DESC, di.position ASC`,
      ),
      execute(
        `SELECT d.*, m.subject, m.sender_name, m.sender_email,
          a.status AS approval_status, a.expires_at AS approval_expires_at
         FROM reply_drafts d
         JOIN email_messages m ON m.id = d.message_id
         LEFT JOIN send_approvals a ON a.id = (
           SELECT id FROM send_approvals sa WHERE sa.draft_id = d.id
           ORDER BY sa.created_at DESC LIMIT 1
         )
         WHERE d.id = (
           SELECT id FROM reply_drafts rd WHERE rd.message_id = d.message_id
           ORDER BY rd.version DESC LIMIT 1
         )
           AND NOT EXISTS (
             SELECT 1 FROM outgoing_drafts od WHERE od.legacy_reply_draft_id = d.id
           )
         ORDER BY d.updated_at DESC LIMIT 50`,
      ),
      execute(
        `SELECT * FROM learned_preferences WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 100`,
      ),
      execute(`SELECT * FROM model_runs ORDER BY created_at DESC LIMIT 50`),
      execute(
        `SELECT a.*, p.purpose_label
         FROM email_accounts a
         LEFT JOIN account_profile_settings p ON p.account_id = a.id
         ORDER BY a.label`,
      ),
      execute(`SELECT key, value FROM settings`),
      execute(`SELECT * FROM mailbox_sweeps ORDER BY updated_at DESC`),
      execute(
        `SELECT COUNT(*) AS count FROM email_messages WHERE status = 'backlog_queued'`,
      ),
      execute(
        `SELECT
          SUM(CASE WHEN COALESCE(t.user_corrected_attention, t.attention) = 'interrupt'
            THEN 1 ELSE 0 END) AS interrupt_count,
          SUM(CASE WHEN COALESCE(t.user_corrected_attention, t.attention) = 'digest'
            THEN 1 ELSE 0 END) AS digest_count,
          SUM(CASE WHEN COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
            THEN 1 ELSE 0 END) AS suppress_count
         FROM email_messages m
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')`,
      ),
      execute(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT m.account_id, m.sender_name, m.sender_email
           FROM email_messages m
           LEFT JOIN triage_decisions t ON t.id = (
             SELECT id FROM triage_decisions td WHERE td.message_id = m.id
             ORDER BY td.created_at DESC LIMIT 1
           )
           WHERE m.is_unread = 1
             AND m.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
             AND COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
             AND lower(COALESCE(t.category, '')) NOT IN (
               'financial', 'finance', 'account-security', 'account-compromise', 'fraud', 'legal'
             )
           GROUP BY m.account_id, m.sender_name, m.sender_email
         )`,
      ),
      execute(
        `SELECT m.account_id, a.email AS account_email, m.sender_name, m.sender_email,
          COUNT(*) AS message_count, MAX(m.received_at) AS latest_received_at,
          (SELECT id FROM email_messages latest
           WHERE latest.account_id = m.account_id
             AND lower(latest.sender_email) = lower(m.sender_email)
             AND latest.is_unread = 1
             AND latest.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
             AND COALESCE((SELECT ltd.user_corrected_attention FROM triage_decisions ltd
                  WHERE ltd.message_id = latest.id
                  ORDER BY ltd.created_at DESC LIMIT 1),
                 (SELECT ltd.attention FROM triage_decisions ltd
                  WHERE ltd.message_id = latest.id
                  ORDER BY ltd.created_at DESC LIMIT 1)) = 'suppress'
             AND lower(COALESCE((SELECT ltd.category FROM triage_decisions ltd
                  WHERE ltd.message_id = latest.id
                  ORDER BY ltd.created_at DESC LIMIT 1), '')) NOT IN (
                    'financial', 'finance', 'account-security', 'account-compromise',
                    'fraud', 'legal'
                  )
           ORDER BY latest.received_at DESC LIMIT 1) AS latest_message_id,
          (SELECT subject FROM email_messages latest
           WHERE latest.account_id = m.account_id
             AND lower(latest.sender_email) = lower(m.sender_email)
             AND latest.is_unread = 1
             AND latest.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
             AND COALESCE((SELECT ltd.user_corrected_attention FROM triage_decisions ltd
                  WHERE ltd.message_id = latest.id
                  ORDER BY ltd.created_at DESC LIMIT 1),
                 (SELECT ltd.attention FROM triage_decisions ltd
                  WHERE ltd.message_id = latest.id
                  ORDER BY ltd.created_at DESC LIMIT 1)) = 'suppress'
             AND lower(COALESCE((SELECT ltd.category FROM triage_decisions ltd
                  WHERE ltd.message_id = latest.id
                  ORDER BY ltd.created_at DESC LIMIT 1), '')) NOT IN (
                    'financial', 'finance', 'account-security', 'account-compromise',
                    'fraud', 'legal'
                  )
           ORDER BY latest.received_at DESC LIMIT 1) AS latest_subject,
          GROUP_CONCAT(DISTINCT COALESCE(t.category, 'uncategorized')) AS categories,
          (SELECT GROUP_CONCAT(action)
           FROM maintenance_rules r
           WHERE r.account_id = m.account_id
             AND lower(r.sender_email) = lower(m.sender_email)
             AND r.enabled = 1) AS approved_actions
         FROM email_messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.is_unread = 1
           AND m.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
           AND COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
           AND lower(COALESCE(t.category, '')) NOT IN (
             'financial', 'finance', 'account-security', 'account-compromise', 'fraud', 'legal'
           )
         GROUP BY m.account_id, a.email, m.sender_name, m.sender_email
         ORDER BY message_count DESC, latest_received_at DESC
         LIMIT 100`,
      ),
      execute(
        `SELECT *
         FROM model_benchmarks
         WHERE run_id = (
           SELECT value FROM service_state WHERE key = 'benchmark_latest_run_id'
         )
         ORDER BY model, case_id`,
      ),
      execute(`SELECT key, value FROM service_state WHERE key LIKE 'benchmark_%'`),
    ]);

  const inbox: InboxItem[] = messageRows.rows.map(dashboardItemFromRow);
  const mailbox: InboxItem[] = mailboxRows.rows.map(dashboardItemFromRow);
  const digestCandidates: InboxItem[] = digestCandidateRows.rows.map(dashboardItemFromRow);
  const digestHistory = digestHistoryFromRows(digestHistoryRows.rows);

  const drafts: DraftItem[] = draftRows.rows.map((row) => ({
    id: String(row.id),
    messageId: String(row.message_id),
    subject: String(row.subject),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    content: String(row.content),
    version: Number(row.version),
    status: String(row.status) as DraftItem["status"],
    approvalStatus: row.approval_status ? String(row.approval_status) : null,
    approvalExpiresAt: row.approval_expires_at ? String(row.approval_expires_at) : null,
    updatedAt: String(row.updated_at),
  }));

  const preferences: LearnedPreference[] = preferenceRows.rows.map((row) => ({
    id: String(row.id),
    accountId: row.account_id ? String(row.account_id) : null,
    kind: String(row.kind),
    pattern: String(row.pattern),
    action: String(row.action),
    weight: Number(row.weight),
    evidenceCount: Number(row.evidence_count),
    enabled: Number(row.enabled) === 1,
    updatedAt: String(row.updated_at),
  }));

  const modelRuns: ModelRun[] = modelRows.rows.map((row) => ({
    id: String(row.id),
    messageId: row.message_id ? String(row.message_id) : null,
    model: String(row.model),
    purpose: String(row.purpose),
    classification: row.classification ? String(row.classification) : null,
    durationMs: Number(row.duration_ms),
    memoryMb:
      row.memory_mb === null || row.memory_mb === undefined ? null : Number(row.memory_mb),
    inputChars: Number(row.input_chars),
    outputChars: Number(row.output_chars),
    valid: Number(row.valid) === 1,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
  }));

  const settingMap = Object.fromEntries(
    settings.rows.map((row) => [String(row.key), String(row.value)]),
  );
  const configuredModel = settingMap.active_model || "qwen3:8b-maxctx";
  const effectiveModel = (
    process.env.EZRA_EMAIL_MODEL_REF ||
    process.env.EZRA_EMAIL_TRIAGE_MODEL ||
    configuredModel
  ).trim();
  const maintenance: DashboardState["maintenance"] = maintenanceRows.rows.map((row) => ({
    accountId: String(row.account_id),
    accountEmail: String(row.account_email),
    latestMessageId: String(row.latest_message_id),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    messageCount: Number(row.message_count),
    latestSubject: String(row.latest_subject || ""),
    latestReceivedAt: String(row.latest_received_at),
    categories: String(row.categories || "")
      .split(",")
      .filter(Boolean),
    approvedActions: String(row.approved_actions || "")
      .split(",")
      .filter(Boolean) as DashboardState["maintenance"][number]["approvedActions"],
  }));
  const accounts: AccountStatus[] = accountRows.rows.map((row) => {
    const id = String(row.id);
    return {
      id,
      provider: String(row.provider || "gmail") as AccountStatus["provider"],
      email: String(row.email),
      label: String(row.label),
      purpose: row.purpose_label ? String(row.purpose_label) : accountPurpose(String(row.provider || "gmail") as AccountStatus["provider"]),
      status: String(row.status) as AccountStatus["status"],
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
      counts: accountCounts(id, inbox, mailbox, maintenance),
    };
  });
  const sweepStatuses = sweepRows.rows.map((row) => String(row.status));
  const backlogStatus = sweepStatuses.includes("running")
    ? "running"
    : sweepStatuses.includes("error")
      ? "error"
      : sweepStatuses.includes("paused")
        ? "paused"
        : sweepStatuses.length && sweepStatuses.every((status) => status === "completed")
          ? "completed"
          : "idle";
  const mostRecentSweep = sweepRows.rows[0];
  const attentionCounts = attentionCountRows.rows[0];
  const benchmarkStateMap = Object.fromEntries(
    benchmarkStateRows.rows.map((row) => [String(row.key), String(row.value)]),
  );
  const benchmarkGroups = new Map<string, typeof benchmarkRows.rows>();
  for (const row of benchmarkRows.rows) {
    const model = String(row.model);
    const current = benchmarkGroups.get(model) || [];
    current.push(row);
    benchmarkGroups.set(model, current);
  }
  const benchmarkSummaries: ModelBenchmarkState["summaries"] = Array.from(
    benchmarkGroups.entries(),
  ).map(([model, rows]) => ({
    runId: String(rows[0]?.run_id || ""),
    model: model as ModelId,
    cases: rows.length,
    score: Math.round(
      rows.reduce((sum, row) => sum + Number(row.score || 0), 0) / Math.max(1, rows.length),
    ),
    attentionAccuracy: Math.round(
      (rows.filter((row) => row.expected_attention === row.actual_attention).length /
        Math.max(1, rows.length)) *
        100,
    ),
    validPercent: Math.round(
      (rows.filter((row) => Number(row.valid) === 1).length / Math.max(1, rows.length)) * 100,
    ),
    averageDurationMs: Math.round(
      rows.reduce((sum, row) => sum + Number(row.duration_ms || 0), 0) /
        Math.max(1, rows.length),
    ),
    averageMemoryMb: Math.round(
      rows.reduce((sum, row) => sum + Number(row.memory_mb || 0), 0) /
        Math.max(1, rows.length),
    ),
    completedAt: String(rows.at(-1)?.created_at || ""),
  }));

  return {
    inbox,
    mailbox,
    drafts,
    preferences,
    modelRuns,
    accounts,
    workspaces: buildMailWorkspaces(accounts),
    maintenance,
    digests: {
      upcoming: buildUpcomingDigests(
        parseJsonArray(settingMap.digest_times),
        settingMap.timezone || "America/Chicago",
        digestCandidates,
      ),
      history: digestHistory,
    },
    activeModel: configuredModel as ModelId,
    effectiveModel,
    benchmarks: {
      status: (benchmarkStateMap.benchmark_status ||
        (benchmarkSummaries.length ? "completed" : "idle")) as ModelBenchmarkState["status"],
      runId: benchmarkStateMap.benchmark_latest_run_id || null,
      startedAt: benchmarkStateMap.benchmark_started_at || null,
      completedAt: benchmarkStateMap.benchmark_completed_at || null,
      progress: benchmarkStateMap.benchmark_progress || null,
      error: benchmarkStateMap.benchmark_error || null,
      caseCount: benchmarkRows.rows.length,
      summaries: benchmarkSummaries,
    },
    updates,
    health,
    counts: {
      interrupt: Number(attentionCounts?.interrupt_count || 0),
      digest: Number(attentionCounts?.digest_count || 0),
      suppress: Number(attentionCounts?.suppress_count || 0),
      maintenance: Number(maintenanceCountRows.rows[0]?.count || 0),
      awaitingApproval: drafts.filter((draft) => draft.status === "awaiting_approval").length,
    },
    backlog: {
      status: backlogStatus,
      query: mostRecentSweep
        ? String(mostRecentSweep.query)
        : process.env.GMAIL_BACKLOG_QUERY || "in:inbox is:unread",
      accounts: sweepRows.rows.length,
      pagesScanned: sweepRows.rows.reduce(
        (sum, row) => sum + Number(row.pages_scanned || 0),
        0,
      ),
      discovered: sweepRows.rows.reduce(
        (sum, row) => sum + Number(row.discovered_count || 0),
        0,
      ),
      queued: Number(backlogQueueRows.rows[0]?.count || 0),
      ruleHandled: sweepRows.rows.reduce(
        (sum, row) => sum + Number(row.rule_handled_count || 0),
        0,
      ),
      modelHandled: sweepRows.rows.reduce(
        (sum, row) => sum + Number(row.model_handled_count || 0),
        0,
      ),
      lastRunAt: mostRecentSweep?.last_run_at ? String(mostRecentSweep.last_run_at) : null,
      error:
        sweepRows.rows.find((row) => row.error)?.error
          ? String(sweepRows.rows.find((row) => row.error)?.error)
          : null,
    },
    schedule: {
      timezone: settingMap.timezone || "America/Chicago",
      pollMinutes: Number(settingMap.poll_minutes || 5),
      digestTimes: parseJsonArray(settingMap.digest_times),
      quietStart: settingMap.quiet_start || "22:00",
      quietEnd: settingMap.quiet_end || "07:00",
    },
  };
}

export async function saveTriageDecision(
  messageId: string,
  model: string,
  result: TriageResult,
) {
  await execute(
    `INSERT INTO triage_decisions
      (id, message_id, model, attention, urgency, confidence, category, summary, reason,
       recommendation, needs_reply, deadline, draft_reply, injection_flags, critical_reason,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("triage"),
      messageId,
      model,
      result.attention,
      result.urgency,
      result.confidence,
      result.category,
      result.summary,
      result.reason,
      result.recommendation,
      result.needsReply ? 1 : 0,
      result.deadline,
      result.draftReply,
      JSON.stringify(result.injectionFlags),
      result.criticalReason,
      nowIso(),
    ],
  );
  await syncMessageSearchIndex(messageId);
}

function dashboardItemFromRow(
  row: Awaited<ReturnType<typeof execute>>["rows"][number],
): InboxItem {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: row.account_provider
      ? (String(row.account_provider) as InboxItem["accountProvider"])
      : undefined,
    externalMessageId: String(row.external_message_id),
    threadId: String(row.thread_id),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    subject: String(row.subject),
    receivedAt: String(row.received_at),
    snippet: String(row.snippet),
    gmailUrl: String(row.gmail_url),
    hasAttachments: Number(row.has_attachments) === 1,
    isUnread: Number(row.is_unread || 0) === 1,
    mailboxLabels: parseJsonArray(row.gmail_labels),
    status: String(row.status),
    attention: row.attention ? (String(row.attention) as InboxItem["attention"]) : null,
    urgency: row.urgency === null || row.urgency === undefined ? null : Number(row.urgency),
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    category: row.category ? String(row.category) : null,
    summary: row.summary ? String(row.summary) : null,
    reason: row.reason ? String(row.reason) : null,
    recommendation: row.recommendation ? String(row.recommendation) : null,
    needsReply: Number(row.needs_reply || 0) === 1,
    deadline: row.deadline ? String(row.deadline) : null,
    injectionFlags: parseJsonArray(row.injection_flags),
    model: row.model ? String(row.model) : null,
    notifiedAt: row.notified_at ? String(row.notified_at) : null,
  };
}

function accountCounts(
  accountId: string,
  inbox: InboxItem[],
  mailbox: InboxItem[],
  maintenance: DashboardState["maintenance"],
) {
  return {
    inbox: mailbox.filter((item) => item.accountId === accountId).length,
    unread: mailbox.filter((item) => item.accountId === accountId && item.isUnread).length,
    interrupt: inbox.filter((item) => item.accountId === accountId && item.attention === "interrupt")
      .length,
    digest: inbox.filter((item) => item.accountId === accountId && item.attention === "digest")
      .length,
    maintenance: maintenance
      .filter((group) => group.accountId === accountId)
      .reduce((sum, group) => sum + group.messageCount, 0),
  };
}

function digestHistoryFromRows(
  rows: Awaited<ReturnType<typeof execute>>["rows"],
): DigestRecord[] {
  const digests = new Map<string, DigestRecord>();
  for (const row of rows) {
    const id = String(row.digest_id || "");
    if (!id) continue;
    let digest = digests.get(id);
    if (!digest) {
      digest = {
        id,
        label: String(row.digest_label || "Email digest"),
        channel: "telegram",
        status: String(row.digest_status || "pending") as DigestRecord["status"],
        itemCount: Number(row.digest_item_count || 0),
        scheduledFor: row.digest_scheduled_for ? String(row.digest_scheduled_for) : null,
        createdAt: String(row.digest_created_at),
        sentAt: row.digest_sent_at ? String(row.digest_sent_at) : null,
        error: row.digest_error ? String(row.digest_error) : null,
        items: [],
      };
      digests.set(id, digest);
    }
    if (row.id) {
      const item = dashboardItemFromRow(row);
      const snapshot = row.summary_snapshot ? String(row.summary_snapshot) : "";
      const recommendation = row.recommendation_snapshot
        ? String(row.recommendation_snapshot)
        : "";
      digest.items.push({
        ...item,
        summary: snapshot || item.summary,
        recommendation: recommendation || item.recommendation,
      });
    }
  }
  return Array.from(digests.values());
}

function buildUpcomingDigests(
  digestTimes: string[],
  timezone: string,
  items: InboxItem[],
): DigestPreview[] {
  const upcoming = (digestTimes.length ? digestTimes : ["08:00", "16:30"])
    .map((time) => ({
      label: digestLabelForTime(time),
      scheduledFor: nextWallClockIso(time, timezone),
      itemCount: items.length,
      items,
    }))
    .sort((left, right) => {
      return new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime();
    });
  return upcoming.slice(0, 1);
}

function digestLabelForTime(time: string) {
  if (time.startsWith("08:")) return "Morning email brief";
  if (time.startsWith("16:")) return "Afternoon email brief";
  return "Email digest";
}

function nextWallClockIso(time: string, timezone: string) {
  const [hour, minute] = time.split(":").map(Number);
  const now = new Date();
  const local = localParts(now, timezone);
  let candidate = zonedTimeToUtc(
    local.year,
    local.month,
    local.day,
    Number.isFinite(hour) ? hour : 8,
    Number.isFinite(minute) ? minute : 0,
    timezone,
  );
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    const nextLocal = localParts(tomorrow, "UTC");
    candidate = zonedTimeToUtc(
      nextLocal.year,
      nextLocal.month,
      nextLocal.day,
      Number.isFinite(hour) ? hour : 8,
      Number.isFinite(minute) ? minute : 0,
      timezone,
    );
  }
  return candidate.toISOString();
}

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
) {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  for (let index = 0; index < 3; index += 1) {
    const parts = localParts(candidate, timezone);
    const actualUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate = new Date(candidate.getTime() + targetUtc - actualUtc);
  }
  return candidate;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
