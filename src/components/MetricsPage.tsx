"use client";

import {
  Activity,
  Cpu,
  HardDrive,
  Inbox,
  MailCheck,
  RefreshCcw,
  Server,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type MetricsState = {
  checkedAt: string;
  resources: {
    totalMemoryGb: number;
    freeMemoryGb: number;
    usedMemoryGb: number;
    appRamMb: number;
    modelRamMb: number;
    loadedModels: Array<{
      name: string;
      sizeGb: number;
      vramGb: number;
      processor: string;
      expiresAt: string | null;
    }>;
    processes: Array<{
      pid: number;
      name: string;
      role: string;
      ramMb: number;
      privateMb: number;
      cpuSeconds: number | null;
      startedAt: string | null;
    }>;
  };
  mail: {
    worker: "running" | "stopped" | "unknown";
    ollama: boolean;
    telegramConfigured: boolean;
    accounts: Array<{
      provider: string;
      email: string;
      status: string;
      unread: number;
      priority: number;
      digest: number;
      maintenance: number;
      lastSyncAt: string | null;
    }>;
    queues: {
      priority: number;
      digest: number;
      maintenance: number;
      awaitingApproval: number;
    };
    backlog: {
      status: string;
      discovered: number;
      queued: number;
      ruleHandled: number;
      modelHandled: number;
      pagesScanned: number;
      lastRunAt: string | null;
      error: string | null;
    };
    digests: {
      nextItemCount: number;
      historyCount: number;
      lastStatus: string | null;
    };
    lastPollAt: string | null;
    lastPollError: string | null;
  };
};

export function MetricsPage() {
  const [metrics, setMetrics] = useState<MetricsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const response = await fetch("/api/metrics", { cache: "no-store" });
      if (!response.ok) throw new Error("Metrics are not available.");
      setMetrics((await response.json()) as MetricsState);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  const handled = useMemo(() => {
    if (!metrics) return 0;
    return metrics.mail.backlog.ruleHandled + metrics.mail.backlog.modelHandled;
  }, [metrics]);
  const discovered = metrics?.mail.backlog.discovered || 0;
  const memoryPercent = metrics
    ? Math.round((metrics.resources.usedMemoryGb / metrics.resources.totalMemoryGb) * 100)
    : 0;

  return (
    <main className="metrics-page">
      <header className="metrics-header">
        <div>
          <span>Email operations</span>
          <h1>Ezra Mail Metrics</h1>
        </div>
        <button className="secondary-button" onClick={() => void refresh()}>
          <RefreshCcw size={16} />
          Refresh
        </button>
      </header>

      {error && <div className="permission-banner">{error}</div>}

      {!metrics ? (
        <section className="metrics-loading">
          <RefreshCcw className="spin" size={22} />
          Loading metrics
        </section>
      ) : (
        <>
          <section className="metrics-overview">
            <MetricTile
              icon={HardDrive}
              label="System memory"
              value={`${metrics.resources.usedMemoryGb} / ${metrics.resources.totalMemoryGb} GB`}
              detail={`${metrics.resources.freeMemoryGb} GB free`}
              percent={memoryPercent}
            />
            <MetricTile
              icon={Cpu}
              label="Ezra app RAM"
              value={`${Math.round(metrics.resources.appRamMb)} MB`}
              detail={`${Math.round(metrics.resources.modelRamMb)} MB model resident`}
              percent={Math.min(100, Math.round(metrics.resources.appRamMb / 100))}
            />
            <MetricTile
              icon={Inbox}
              label="Mail queues"
              value={`${metrics.mail.queues.priority} priority`}
              detail={`${metrics.mail.queues.maintenance} cleanup / ${metrics.mail.queues.digest} digest`}
              percent={Math.min(100, metrics.mail.queues.priority * 10)}
            />
            <MetricTile
              icon={MailCheck}
              label="Backlog progress"
              value={`${handled} handled`}
              detail={`${discovered} discovered / ${metrics.mail.backlog.queued} queued`}
              percent={discovered ? Math.round((handled / discovered) * 100) : 0}
            />
          </section>

          <section className="metrics-split">
            <div className="metrics-panel">
              <div className="metrics-panel-heading">
                <Activity size={18} />
                <h2>Services</h2>
              </div>
              <div className="service-matrix">
                <ServiceRow label="Worker" value={metrics.mail.worker} good={metrics.mail.worker === "running"} />
                <ServiceRow label="Ollama" value={metrics.mail.ollama ? "ready" : "offline"} good={metrics.mail.ollama} />
                <ServiceRow
                  label="Telegram"
                  value={metrics.mail.telegramConfigured ? "configured" : "not configured"}
                  good={metrics.mail.telegramConfigured}
                />
                <ServiceRow
                  label="Last poll"
                  value={metrics.mail.lastPollAt ? formatRelative(metrics.mail.lastPollAt) : "not yet"}
                  good={!metrics.mail.lastPollError}
                />
              </div>
              {metrics.resources.loadedModels.length === 0 ? (
                <div className="model-idle">
                  <Server size={18} />
                  No local model is loaded in RAM right now.
                </div>
              ) : (
                <div className="loaded-model-list">
                  {metrics.resources.loadedModels.map((model) => (
                    <div className="loaded-model-row" key={model.name}>
                      <b>{model.name}</b>
                      <span>{model.sizeGb} GB / {model.processor}</span>
                      <small>{model.expiresAt ? `unloads ${formatRelative(model.expiresAt)}` : "resident"}</small>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="metrics-panel">
              <div className="metrics-panel-heading">
                <MailCheck size={18} />
                <h2>Mailbox Work</h2>
              </div>
              <div className="mail-account-metrics">
                {metrics.mail.accounts.length === 0 ? (
                  <div className="model-idle">No mail accounts connected.</div>
                ) : (
                  metrics.mail.accounts.map((account) => (
                    <article className="mail-account-row" key={`${account.provider}:${account.email}`}>
                      <div>
                        <b>{account.email}</b>
                        <span>{humanize(account.provider)} / {humanize(account.status)}</span>
                      </div>
                      <div>
                        <small><b>{account.unread}</b> unread</small>
                        <small><b>{account.priority}</b> priority</small>
                        <small><b>{account.maintenance}</b> cleanup</small>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className="metrics-panel">
            <div className="metrics-panel-heading">
              <Server size={18} />
              <h2>Process Memory</h2>
            </div>
            <div className="process-table">
              <div className="process-row header">
                <span>Process</span>
                <span>Role</span>
                <span>RAM</span>
                <span>CPU</span>
              </div>
              {metrics.resources.processes.slice(0, 12).map((process) => (
                <div className="process-row" key={`${process.pid}:${process.role}`}>
                  <span>{process.name} #{process.pid}</span>
                  <span>{process.role}</span>
                  <span>{process.ramMb} MB</span>
                  <span>{process.cpuSeconds === null ? "-" : `${process.cpuSeconds}s`}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  percent: number;
}) {
  return (
    <article className="metric-tile">
      <div>
        <Icon size={19} />
        <span>{label}</span>
      </div>
      <b>{value}</b>
      <small>{detail}</small>
      <i><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></i>
    </article>
  );
}

function ServiceRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="service-row">
      <span>{label}</span>
      <b className={good ? "good" : ""}>{value}</b>
    </div>
  );
}

function formatRelative(value: string) {
  const date = new Date(value);
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? "soon" : "now";
  if (abs < 3_600_000) {
    const minutes = Math.round(abs / 60_000);
    return diff >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  const hours = Math.round(abs / 3_600_000);
  return diff >= 0 ? `in ${hours}h` : `${hours}h ago`;
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
