import type { Client } from "@libsql/client";

/** Additive v5 evidence. Old display timestamps never synthesize owner intent. */
export async function migrateNotificationGovernorSchema(client: Client) {
  const tx = await client.transaction("write");
  try {
    const version = Number((await tx.execute("PRAGMA user_version")).rows[0].user_version);
    await tx.execute(`CREATE TABLE IF NOT EXISTS notification_policy_evidence (
      source_key TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES email_messages(id),
      event_id TEXT REFERENCES notification_events(id), account_id TEXT NOT NULL REFERENCES email_accounts(id),
      sender_hash TEXT NOT NULL, category TEXT NOT NULL CHECK(length(category)<=100),
      grouping_key TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('interrupt','brief','checkin','in_app')),
      critical INTEGER NOT NULL CHECK(critical IN (0,1)), reason_code TEXT NOT NULL CHECK(length(reason_code)<=40),
      rule_trace TEXT NOT NULL CHECK(length(rule_trace)<=2048 AND json_valid(rule_trace)), created_at TEXT NOT NULL
    )`);
    await tx.execute("CREATE INDEX IF NOT EXISTS idx_notification_event_admission ON notification_events(kind,created_at)");
    await tx.execute("CREATE INDEX IF NOT EXISTS idx_notification_policy_events ON notification_policy_evidence(event_id,critical,created_at)");
    await tx.execute("CREATE INDEX IF NOT EXISTS idx_notification_policy_sender ON notification_policy_evidence(account_id,sender_hash,event_id)");
    await tx.execute("CREATE INDEX IF NOT EXISTS idx_notification_policy_group ON notification_policy_evidence(account_id,grouping_key,critical,event_id)");
    await tx.execute(`CREATE TABLE IF NOT EXISTS brief_notification_actions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL CHECK(source_type='mail_thread'), source_account_id TEXT NOT NULL,
      source_key TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('gmail','microsoft')), provider_thread_id TEXT NOT NULL,
      source_revision_at TEXT NOT NULL, effective_at TEXT NOT NULL, observed_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('complete','dismiss','bring_back','baseline_complete','baseline_dismiss','external'))
    )`);
    await tx.execute("CREATE INDEX IF NOT EXISTS idx_brief_notification_identity ON brief_notification_actions(source_account_id,source_key,provider,provider_thread_id,sequence)");
    const columns = (await tx.execute("PRAGMA table_info(notification_attempts)")).rows;
    if (!columns.some(row => row.name === "resolved_target")) await tx.execute("ALTER TABLE notification_attempts ADD COLUMN resolved_target TEXT");
    const deliveryColumns = (await tx.execute("PRAGMA table_info(notification_deliveries)")).rows;
    if (!deliveryColumns.some(row => row.name === "cancellation_reason")) await tx.execute("ALTER TABLE notification_deliveries ADD COLUMN cancellation_reason TEXT CHECK(cancellation_reason IS NULL OR length(cancellation_reason)<=40)");
    if (version < 5) {
      // Baselines precede all future explicit actions. Stable IDs provide idempotence only.
      // A historical Sent link does not prove the current completion: require its
      // exact current revision, completed time and explicit evidence snapshot.
      await tx.execute(`INSERT OR IGNORE INTO brief_notification_actions
        (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind)
        SELECT 'baseline_'||m.id,'mail_thread',m.source_account_id,m.source_key,a.provider,json_extract(m.target_json,'$.providerThreadId'),
          m.source_revision_at,COALESCE(CASE WHEN m.state='completed' THEN m.completed_at ELSE m.dismissed_at END,''),m.updated_at,
          CASE WHEN m.state='completed' THEN 'baseline_complete' ELSE 'baseline_dismiss' END
        FROM brief_item_memory m JOIN email_accounts a ON a.id=m.source_account_id
        WHERE m.source_type='mail_thread' AND m.state IN ('completed','dismissed') AND json_valid(m.target_json)
          AND a.provider=json_extract(m.target_json,'$.provider') AND a.provider IN ('gmail','microsoft')
          AND length(json_extract(m.target_json,'$.providerThreadId'))>0
          AND m.source_key='mail:'||m.source_account_id||':'||json_extract(m.target_json,'$.providerThreadId')
          AND NOT (m.state='completed' AND EXISTS (SELECT 1 FROM reply_completion_evidence_links l JOIN reply_completion_evidence e ON e.id=l.evidence_id
            WHERE l.brief_item_id=m.id AND e.account_id=m.source_account_id AND e.source_key=m.source_key
              AND e.provider=a.provider AND e.provider_thread_id=json_extract(m.target_json,'$.providerThreadId')
              AND l.source_revision_at=m.source_revision_at AND e.provider_sent_at=m.completed_at
              AND CASE WHEN json_valid(m.completion_evidence_json) THEN
                json_extract(m.completion_evidence_json,'$.kind')='external_reply'
                AND json_extract(m.completion_evidence_json,'$.evidenceId')=e.id
              ELSE 0 END))
        ORDER BY m.id`);
      await tx.execute(`INSERT OR IGNORE INTO brief_notification_actions
        (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind)
        SELECT 'external_'||l.id,'mail_thread',e.account_id,e.source_key,e.provider,e.provider_thread_id,l.source_revision_at,e.provider_sent_at,e.observed_at,'external'
        FROM reply_completion_evidence_links l JOIN reply_completion_evidence e ON e.id=l.evidence_id JOIN brief_item_memory m ON m.id=l.brief_item_id
        WHERE m.source_type='mail_thread' AND m.source_account_id=e.account_id AND m.source_key=e.source_key
          AND e.source_key='mail:'||e.account_id||':'||e.provider_thread_id AND json_valid(m.target_json)
          AND json_extract(m.target_json,'$.provider')=e.provider AND json_extract(m.target_json,'$.providerThreadId')=e.provider_thread_id
        ORDER BY l.id`);
      // v3 could reject malformed chronology before producing a link. Preserve that
      // identifiable proof conservatively, rather than treating an open snapshot as consent.
      await tx.execute(`INSERT OR IGNORE INTO brief_notification_actions
        (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind)
        SELECT 'external_unlinked_'||e.id,'mail_thread',e.account_id,e.source_key,e.provider,e.provider_thread_id,m.source_revision_at,e.provider_sent_at,e.observed_at,'external'
        FROM reply_completion_evidence e JOIN brief_item_memory m ON m.id=e.brief_item_id
        WHERE m.source_type='mail_thread' AND m.source_account_id=e.account_id AND m.source_key=e.source_key
          AND e.source_key='mail:'||e.account_id||':'||e.provider_thread_id AND json_valid(m.target_json)
          AND json_extract(m.target_json,'$.provider')=e.provider AND json_extract(m.target_json,'$.providerThreadId')=e.provider_thread_id
          AND NOT EXISTS (SELECT 1 FROM reply_completion_evidence_links l WHERE l.evidence_id=e.id)
        ORDER BY e.id`);
      await tx.execute("PRAGMA user_version=5");
    }
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
  finally { tx.close(); }
}
