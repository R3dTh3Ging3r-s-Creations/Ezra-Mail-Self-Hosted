"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Send,
  Users,
  X,
} from "lucide-react";
import type {
  CalendarAccountStatus,
  CalendarActionResult,
  CalendarDraft,
  CalendarEvent,
  CalendarPage,
  CalendarPrivacy,
  MailWorkspace,
} from "@/lib/email/types";
import { api, post } from "./api";
import {
  calendarPeriod,
  calendarEventOverlapsDay,
  isCalendarViewMode,
  parseCalendarDate,
  serializeCalendarDate,
  shiftCalendarAnchor,
  type CalendarViewMode,
  type CalendarDrilldownRequest,
} from "./calendarViewState";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import styles from "./EzraMail.module.css";

type CalendarForm = {
  accountId: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  timezone: string;
  location: string;
  description: string;
  attendees: string;
  reminderMinutes: string;
  isBusy: boolean;
  privacy: CalendarPrivacy;
  sendUpdates: boolean;
};

export function CalendarView(props: {
  workspaceId: string;
  workspace: MailWorkspace | null;
  onOpenSettings: () => void;
  onDailyBriefChanged?: (sourceWorkspaceId: string) => void | Promise<void>;
  target?: CalendarDrilldownRequest | null;
  onClearTarget?: () => void;
}) {
  const [preferredMode, setMode] = useState<CalendarViewMode>("week");
  const [preferredDate, setAnchorDate] = useState(() => new Date());
  const mode = props.target ? "day" : preferredMode;
  const anchorDate = useMemo(() => props.target ? parseCalendarDate(props.target.date) : preferredDate, [props.target?.date, preferredDate]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [page, setPage] = useState<CalendarPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [targetMissing, setTargetMissing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewDraft, setReviewDraft] = useState<CalendarDraft | null>(null);
  const [confirmInvites, setConfirmInvites] = useState(false);
  const [sendGuestUpdates, setSendGuestUpdates] = useState(false);
  const [form, setForm] = useState<CalendarForm>(() => defaultForm());
  const beginRequest = useLatestRequest();

  const period = useMemo(() => calendarPeriod(anchorDate, mode), [anchorDate, mode]);
  const range = useMemo(() => ({
    from: period.from.toISOString(),
    to: period.to.toISOString(),
  }), [period.from, period.to]);
  const scope = JSON.stringify([props.workspaceId, range.from, range.to, props.target?.requestKey, props.target?.eventId]);
  const latestScope = useRef(scope);
  latestScope.current = scope;

  useEffect(() => {
    if (!props.target) return;
    setMode("day");
    setAnchorDate(parseCalendarDate(props.target.date));
  }, [props.target?.date, props.target?.requestKey]);

  useEffect(() => {
    const storedMode = localStorage.getItem("ezra-calendar-mode");
    const storedDate = localStorage.getItem("ezra-calendar-date");
    if (!props.target && isCalendarViewMode(storedMode)) setMode(storedMode);
    if (!props.target && storedDate) setAnchorDate(parseCalendarDate(storedDate));
    setPreferencesReady(true);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    localStorage.setItem("ezra-calendar-mode", mode);
    localStorage.setItem("ezra-calendar-date", serializeCalendarDate(anchorDate));
  }, [anchorDate, mode, preferencesReady]);

  const loadCalendar = useCallback(async (options: { quiet?: boolean; sync?: boolean } = {}) => {
    if (latestScope.current !== scope) return;
    const request = beginRequest();
    const isCurrent = () => request.isLatest() && latestScope.current === scope;
    if (options.quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError("");
      setSelectedEvent(null);
      setTargetMissing(false);
      setPage(null);
    }
    try {
      const params = new URLSearchParams({
        workspaceId: props.workspaceId,
        from: range.from,
        to: range.to,
      });
      if (options.sync === false || props.target) params.set("sync", "false");
      if (props.target) params.set("date", props.target.date);
      const next = await api<CalendarPage>(`/api/calendar?${params.toString()}`, { signal: request.signal });
      if (!isCurrent()) return;
      setPage(next);
      if (props.target) {
        const exact = next.events.find((event) => event.id === props.target!.eventId) || null;
        setSelectedEvent(exact);
        setTargetMissing(!exact);
      }
      setForm((current) => {
        if (current.accountId || !next.accounts[0]) return current;
        return { ...current, accountId: next.accounts[0].accountId, timezone: next.range.timezone };
      });
    } catch (nextError) {
      if (!options.quiet && isCurrent() && !isAbortError(nextError)) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (isCurrent()) {
        if (options.quiet) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [beginRequest, props.workspaceId, range.from, range.to, scope, props.target]);

  useEffect(() => {
    if (!preferencesReady) return;
    void loadCalendar();
  }, [loadCalendar, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return undefined;
    const refresh = () => void loadCalendar({ quiet: true });
    window.addEventListener("ezra:refresh", refresh);
    return () => window.removeEventListener("ezra:refresh", refresh);
  }, [loadCalendar, preferencesReady]);

  useEffect(() => {
    setSelectedEvent(null);
    setReviewDraft(null);
    setForm(defaultForm());
  }, [props.workspaceId]);

  async function manualSync() {
    const sourceWorkspaceId = props.workspaceId;
    const sourceAccountIds = new Set((page?.accounts || []).map((account) => account.accountId));
    setSyncing(true);
    setNotice("");
    setError("");
    try {
      const result = await post<CalendarActionResult>("/api/calendar/actions", {
        action: "sync",
        workspaceId: props.workspaceId,
        from: range.from,
        to: range.to,
      });
      setNotice(result.message);
      await loadCalendar({ quiet: true, sync: false });
      const failures = result.failures || [];
      const failedAccountIds = new Set(failures.map((failure) => failure.accountId));
      const hasConfirmedCount = typeof result.synced === "number";
      const hasConfirmedFullSuccess = result.ok && failures.length === 0;
      const hasConfirmedPartialSuccess = !result.ok
        && failures.length > 0
        && failedAccountIds.size === failures.length
        && [...failedAccountIds].every((accountId) => sourceAccountIds.has(accountId))
        && failedAccountIds.size < sourceAccountIds.size;
      if (hasConfirmedCount && (hasConfirmedFullSuccess || hasConfirmedPartialSuccess)) {
        await props.onDailyBriefChanged?.(sourceWorkspaceId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSyncing(false);
    }
  }

  function openDraft() {
    const account = page?.accounts.find((item) => item.calendarStatus === "connected") || page?.accounts[0];
    setForm({ ...defaultForm(page?.range.timezone), accountId: account?.accountId || "" });
    setFormOpen(true);
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const sourceWorkspaceId = props.workspaceId;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const result = await post<CalendarActionResult>("/api/calendar/actions", {
        action: "draft_create",
        draft: draftPayload(form),
      });
      if (result.draft) {
        setReviewDraft(result.draft);
        setConfirmInvites(false);
        setSendGuestUpdates(result.draft.sendUpdates);
        setFormOpen(false);
      }
      setNotice(result.message);
      if (result.ok && result.draft) {
        await props.onDailyBriefChanged?.(sourceWorkspaceId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function createEvent() {
    if (!reviewDraft) return;
    const sourceWorkspaceId = props.workspaceId;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const result = await post<CalendarActionResult>("/api/calendar/actions", {
        action: "create_event",
        draftId: reviewDraft.id,
        confirmInvites,
        sendUpdates: sendGuestUpdates,
      });
      setNotice(result.message);
      setReviewDraft(null);
      await loadCalendar({ quiet: true, sync: false });
      if (result.event) setSelectedEvent(result.event);
      if (result.ok && result.event) {
        await props.onDailyBriefChanged?.(sourceWorkspaceId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function cancelDraft(draft: CalendarDraft) {
    const sourceWorkspaceId = props.workspaceId;
    setSaving(true);
    try {
      const result = await post<CalendarActionResult>("/api/calendar/actions", {
        action: "draft_cancel",
        draftId: draft.id,
      });
      setReviewDraft(null);
      await loadCalendar({ quiet: true, sync: false });
      if (result.ok) {
        await props.onDailyBriefChanged?.(sourceWorkspaceId);
      }
    } finally {
      setSaving(false);
    }
  }

  const days = period.days;
  const eventsByDay = useMemo(() => groupEventsByDay(page?.events || [], days, page?.range.timezone), [page?.events, page?.range.timezone, days]);
  const connectedAccounts = page?.accounts.filter((account) => account.calendarStatus === "connected") || [];
  const setupAccounts = page?.accounts.filter((account) => account.calendarStatus !== "connected") || [];
  const title = props.workspace?.isAllAccounts ? "All calendars" : `${props.workspace?.label || "Workspace"} calendar`;
  const agendaDays = mode === "month" ? days.filter((day) => (eventsByDay.get(dayKey(day)) || []).length > 0) : days;

  return (
    <div className={styles.calendarView} aria-busy={refreshing || loading}>
      <section className={styles.calendarHero}>
        <div>
          <span className={styles.dateLabel}>{period.label}</span>
          <h2>{title}</h2>
          <p>Agenda plus {mode} view. Ezra can create events only from drafts you explicitly approve.</p>
        </div>
        <div className={styles.calendarHeroActions}>
          <button className={styles.secondaryButton} disabled={syncing} onClick={manualSync}>
            {syncing ? <LoaderCircle aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {syncing ? "Syncing..." : "Sync calendars"}
          </button>
          <button className={styles.primaryButton} disabled={!page?.accounts.length} onClick={openDraft}>
            <Plus aria-hidden="true" /> New event draft
          </button>
        </div>
      </section>

      {notice ? <div className={styles.calendarNotice}>{notice}</div> : null}
      {targetMissing ? <div className={styles.calendarNotice} role="status">This event is no longer available in this workspace. The requested day is still shown.</div> : null}
      {error ? <div className={styles.errorState}><strong>Calendar could not load.</strong><p>{error}</p><button onClick={() => void loadCalendar()}>Try again</button></div> : null}

      <section className={styles.calendarToolbar}>
        <div className={styles.calendarModeSelector} role="group" aria-label="Calendar view mode">
          {(["day", "week", "month"] as CalendarViewMode[]).map((item) => (
            <button key={item} aria-pressed={mode === item} className={mode === item ? styles.calendarModeActive : ""} onClick={() => { props.onClearTarget?.(); setMode(item); }}>{capitalize(item)}</button>
          ))}
        </div>
        <button aria-label={`Previous ${period.noun}`} onClick={() => { props.onClearTarget?.(); setAnchorDate(shiftCalendarAnchor(anchorDate, mode, -1)); }}><ChevronLeft aria-hidden="true" /> Previous</button>
        <button onClick={() => { props.onClearTarget?.(); setAnchorDate(new Date()); }}>Today</button>
        <button aria-label={`Next ${period.noun}`} onClick={() => { props.onClearTarget?.(); setAnchorDate(shiftCalendarAnchor(anchorDate, mode, 1)); }}>Next <ChevronRight aria-hidden="true" /></button>
        <span>{page?.range.timezone || "America/Chicago"}</span>
      </section>

      {isInitialPanelLoad(loading, Boolean(page)) ? <div className={styles.listLoading}><LoaderCircle aria-hidden="true" /> Loading calendar...</div> : null}

      {!loading && page && !page.accounts.length ? (
        <CalendarSetupEmpty onOpenSettings={props.onOpenSettings} />
      ) : null}

      {page && page.accounts.length ? (
        <>
          <section className={styles.calendarAccounts} aria-label="Calendar accounts">
            {page.accounts.map((account) => (
              <div key={account.accountId} className={account.provider === "microsoft" ? styles.calendarAccountMicrosoft : styles.calendarAccountGmail}>
                <strong>{account.accountLabel}</strong>
                <span>{account.provider === "microsoft" ? "Hotmail / Outlook" : "Google Calendar"} · {account.calendarStatus === "connected" ? "Connected" : "Needs calendar access"}</span>
                {account.lastError ? <small>{account.lastError}</small> : <small>{account.lastSyncAt ? `Synced ${relativeTime(account.lastSyncAt)}` : "Not synced yet"}</small>}
              </div>
            ))}
          </section>

          {setupAccounts.length && !connectedAccounts.length ? (
            <CalendarSetupEmpty onOpenSettings={props.onOpenSettings} accounts={setupAccounts} />
          ) : null}

          <div className={styles.calendarWorkspace}>
            <section className={styles.calendarAgenda} aria-label="Calendar agenda">
              <header><h2>Agenda</h2><span>{page.events.length} event{page.events.length === 1 ? "" : "s"} this {period.noun}</span></header>
              {!page.events.length ? <div className={styles.calendarEmpty}><CalendarDays aria-hidden="true" /><h3>No events in this range</h3><p>Ezra checked the selected workspace and did not find events for this {period.noun}.</p></div> : null}
              {agendaDays.map((day) => (
                <div key={day.toISOString()} className={styles.agendaDay}>
                  <h3>{formatDayHeading(day)}</h3>
                  {(eventsByDay.get(dayKey(day)) || []).map((event) => (
                    <button key={event.id} className={styles.agendaEvent} onClick={() => setSelectedEvent(event)}>
                      <span className={event.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}>{event.accountLabel}</span>
                      <strong>{event.title}</strong>
                      <small>{event.isAllDay ? "All day" : `${formatTime(event.startsAt)} – ${formatTime(event.endsAt)}`}{event.location ? ` · ${event.location}` : ""}</small>
                    </button>
                  ))}
                </div>
              ))}
            </section>

            <CalendarPeriodGrid
              mode={mode}
              days={days}
              eventsByDay={eventsByDay}
              onSelect={setSelectedEvent}
              onFocusDay={(day) => { setAnchorDate(day); setMode("day"); }}
            />
          </div>

          {page.drafts.length ? (
            <section className={styles.calendarDraftStrip}>
              <h2>Drafts waiting for approval</h2>
              <div>
                {page.drafts.map((draft) => (
                  <button key={draft.id} onClick={() => { setReviewDraft(draft); setSendGuestUpdates(draft.sendUpdates); }}>
                    <strong>{draft.title}</strong>
                    <span>{draft.accountLabel} · {formatDateTime(draft.startsAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {selectedEvent ? <EventDrawer event={selectedEvent} onClose={() => setSelectedEvent(null)} /> : null}
      {formOpen && page ? (
        <EventDraftDialog
          accounts={page.accounts}
          form={form}
          saving={saving}
          onChange={setForm}
          onClose={() => setFormOpen(false)}
          onSubmit={saveDraft}
        />
      ) : null}
      {reviewDraft ? (
        <ReviewDialog
          draft={reviewDraft}
          saving={saving}
          confirmInvites={confirmInvites}
          sendGuestUpdates={sendGuestUpdates}
          onConfirmInvites={setConfirmInvites}
          onSendGuestUpdates={setSendGuestUpdates}
          onCancel={() => cancelDraft(reviewDraft)}
          onClose={() => setReviewDraft(null)}
          onCreate={createEvent}
        />
      ) : null}
    </div>
  );
}

function CalendarPeriodGrid(props: {
  mode: CalendarViewMode;
  days: Date[];
  eventsByDay: Map<string, CalendarEvent[]>;
  onSelect: (event: CalendarEvent) => void;
  onFocusDay: (day: Date) => void;
}) {
  if (props.mode === "day") {
    const day = props.days[0];
    const events = props.eventsByDay.get(dayKey(day)) || [];
    return (
      <aside className={styles.dayGrid} aria-label="Calendar day">
        <header><strong>{formatDayHeading(day)}</strong><span>{events.length} event{events.length === 1 ? "" : "s"}</span></header>
        <div>
          {events.map((event) => <CalendarGridEvent key={event.id} event={event} onSelect={props.onSelect} />)}
          {!events.length ? <p>No scheduled events.</p> : null}
        </div>
      </aside>
    );
  }
  if (props.mode === "month") {
    return (
      <aside className={styles.monthGrid} aria-label="Calendar month">
        <div className={styles.monthWeekdays}>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <strong key={day}>{day}</strong>)}</div>
        <div className={styles.monthDays}>
          {props.days.map((day, index) => {
            const events = props.eventsByDay.get(dayKey(day)) || [];
            return (
              <div key={day.toISOString()} className={isSameDay(day, new Date()) ? styles.monthDayToday : styles.monthDay} style={index === 0 ? { gridColumnStart: day.getDay() + 1 } : undefined}>
                <header><button aria-label={`Open ${formatDayHeading(day)} in Day view`} onClick={() => props.onFocusDay(day)}>{day.getDate()}</button></header>
                {events.slice(0, 3).map((event) => <CalendarGridEvent key={event.id} event={event} onSelect={props.onSelect} compact />)}
                {events.length > 3 ? <span className={styles.calendarOverflow}>+{events.length - 3} more</span> : null}
              </div>
            );
          })}
        </div>
      </aside>
    );
  }
  return (
    <aside className={styles.weekGrid} aria-label="Calendar week">
      {props.days.map((day) => {
        const events = props.eventsByDay.get(dayKey(day)) || [];
        return (
          <div key={day.toISOString()} className={isSameDay(day, new Date()) ? styles.weekDayToday : styles.weekDay}>
            <header><strong>{shortWeekday(day)}</strong><span>{day.getDate()}</span></header>
            <div>
              {events.slice(0, 4).map((event) => <CalendarGridEvent key={event.id} event={event} onSelect={props.onSelect} compact />)}
              {events.length > 4 ? <span className={styles.calendarOverflow}>+{events.length - 4} more</span> : null}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function CalendarGridEvent(props: { event: CalendarEvent; onSelect: (event: CalendarEvent) => void; compact?: boolean }) {
  const event = props.event;
  return (
    <button className={event.accountProvider === "microsoft" ? styles.weekEventMicrosoft : styles.weekEvent} onClick={() => props.onSelect(event)}>
      <span>{event.accountLabel}</span>
      <strong>{event.title}</strong>
      {!props.compact ? <small>{event.isAllDay ? "All day" : `${formatTime(event.startsAt)} – ${formatTime(event.endsAt)}`}</small> : null}
    </button>
  );
}

function CalendarSetupEmpty(props: { onOpenSettings: () => void; accounts?: CalendarAccountStatus[] }) {
  return (
    <section className={styles.calendarSetupEmpty}>
      <CalendarDays aria-hidden="true" />
      <h2>Calendar access is not connected yet</h2>
      <p>{props.accounts?.length ? "These accounts are connected for mail, but need a calendar permission upgrade." : "Connect Gmail or Hotmail first, then enable calendar access per account."}</p>
      <button className={styles.primaryButton} onClick={props.onOpenSettings}>Open Settings</button>
    </section>
  );
}

function EventDrawer(props: { event: CalendarEvent; onClose: () => void }) {
  const event = props.event;
  return (
    <div className={styles.drawerBackdrop} role="presentation" onMouseDown={props.onClose}>
      <aside className={styles.eventDrawer} role="dialog" aria-modal="true" aria-labelledby="event-drawer-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>{event.accountLabel} · {event.calendarName}</span><h2 id="event-drawer-title">{event.title}</h2></div>
          <button className={styles.iconButtonSmall} onClick={props.onClose} aria-label="Close event"><X aria-hidden="true" /></button>
        </header>
        <dl>
          <div><dt><Clock3 aria-hidden="true" /> When</dt><dd>{event.isAllDay ? `${formatDate(event.startsAt)} · all day` : `${formatDateTime(event.startsAt)} – ${formatDateTime(event.endsAt)}`}</dd></div>
          {event.location ? <div><dt><MapPin aria-hidden="true" /> Where</dt><dd>{event.location}</dd></div> : null}
          {event.attendees.length ? <div><dt><Users aria-hidden="true" /> Attendees</dt><dd>{event.attendees.map((attendee) => attendee.email).join(", ")}</dd></div> : null}
        </dl>
        {event.description ? <p>{event.description.slice(0, 1400)}</p> : <p className={styles.mutedCopy}>No description.</p>}
        {event.webLink ? <a className={styles.originalLink} href={event.webLink} target="_blank" rel="noreferrer">Open original <ExternalLink aria-hidden="true" /></a> : null}
      </aside>
    </div>
  );
}

function EventDraftDialog(props: {
  accounts: CalendarAccountStatus[];
  form: CalendarForm;
  saving: boolean;
  onChange: (form: CalendarForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const account = props.accounts.find((item) => item.accountId === props.form.accountId);
  const update = <K extends keyof CalendarForm>(key: K, value: CalendarForm[K]) => props.onChange({ ...props.form, [key]: value });
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <form className={styles.calendarDialog} role="dialog" aria-modal="true" aria-labelledby="calendar-draft-title" onSubmit={props.onSubmit}>
        <header><div><span>Manual calendar draft</span><h2 id="calendar-draft-title">Create event draft</h2></div><button type="button" className={styles.iconButtonSmall} onClick={props.onClose} aria-label="Close"><X aria-hidden="true" /></button></header>
        <label>Account<select value={props.form.accountId} onChange={(event) => update("accountId", event.target.value)} required>{props.accounts.map((item) => <option key={item.accountId} value={item.accountId}>{item.accountLabel} ({item.provider})</option>)}</select></label>
        {account?.calendarStatus !== "connected" ? <p className={styles.calendarWarning}>This account may need calendar access upgraded in Settings before provider creation will work.</p> : null}
        <label>Title<input value={props.form.title} onChange={(event) => update("title", event.target.value)} required placeholder="Interview, reminder, appointment..." /></label>
        <div className={styles.calendarFormGrid}>
          <label>Date<input type="date" value={props.form.date} onChange={(event) => update("date", event.target.value)} required /></label>
          <label>Start<input type="time" value={props.form.startTime} onChange={(event) => update("startTime", event.target.value)} disabled={props.form.allDay} required /></label>
          <label>End<input type="time" value={props.form.endTime} onChange={(event) => update("endTime", event.target.value)} disabled={props.form.allDay} required /></label>
        </div>
        <label className={styles.confirmCheck}><input type="checkbox" checked={props.form.allDay} onChange={(event) => update("allDay", event.target.checked)} /> All-day event</label>
        <label>Timezone<input value={props.form.timezone} onChange={(event) => update("timezone", event.target.value)} /></label>
        <label>Location<input value={props.form.location} onChange={(event) => update("location", event.target.value)} placeholder="Optional" /></label>
        <label>Attendees<input value={props.form.attendees} onChange={(event) => update("attendees", event.target.value)} placeholder="Optional, comma-separated emails" /></label>
        <label>Description<textarea rows={4} value={props.form.description} onChange={(event) => update("description", event.target.value)} /></label>
        <div className={styles.calendarFormGrid}>
          <label>Reminder<select value={props.form.reminderMinutes} onChange={(event) => update("reminderMinutes", event.target.value)}><option value="">Default</option><option value="10">10 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option></select></label>
          <label>Show as<select value={props.form.isBusy ? "busy" : "free"} onChange={(event) => update("isBusy", event.target.value === "busy")}><option value="busy">Busy</option><option value="free">Free</option></select></label>
          <label>Privacy<select value={props.form.privacy} onChange={(event) => update("privacy", event.target.value as CalendarPrivacy)}><option value="default">Default</option><option value="private">Private</option><option value="public">Public</option></select></label>
        </div>
        <footer><button type="button" className={styles.secondaryButton} onClick={props.onClose}>Cancel</button><button className={styles.primaryButton} disabled={props.saving}>{props.saving ? "Saving..." : "Save draft for review"}</button></footer>
      </form>
    </div>
  );
}

function ReviewDialog(props: {
  draft: CalendarDraft;
  saving: boolean;
  confirmInvites: boolean;
  sendGuestUpdates: boolean;
  onConfirmInvites: (value: boolean) => void;
  onSendGuestUpdates: (value: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const needsMicrosoftInviteConfirm = props.draft.accountProvider === "microsoft" && props.draft.attendees.length > 0;
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.sendDialog} role="alertdialog" aria-modal="true" aria-labelledby="calendar-review-title">
        <span className={styles.dialogEyebrow}>Exact calendar review</span>
        <h2 id="calendar-review-title">{props.draft.title}</h2>
        <p>{props.draft.accountLabel} · {props.draft.isAllDay ? `${formatDate(props.draft.startsAt)} all day` : `${formatDateTime(props.draft.startsAt)} – ${formatDateTime(props.draft.endsAt)}`}</p>
        {props.draft.location ? <p>Location: {props.draft.location}</p> : null}
        {props.draft.description ? <p>{props.draft.description}</p> : null}
        {props.draft.attendees.length ? <p>Attendees: {props.draft.attendees.join(", ")}</p> : <p>No attendees. This creates a private calendar block only.</p>}
        {props.draft.accountProvider === "gmail" && props.draft.attendees.length ? (
          <label className={styles.confirmCheck}><input type="checkbox" checked={props.sendGuestUpdates} onChange={(event) => props.onSendGuestUpdates(event.target.checked)} /> Send Google guest update emails</label>
        ) : null}
        {needsMicrosoftInviteConfirm ? (
          <label className={styles.confirmCheck}><input type="checkbox" checked={props.confirmInvites} onChange={(event) => props.onConfirmInvites(event.target.checked)} /> Create this Outlook event and send invitations</label>
        ) : null}
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} disabled={props.saving} onClick={props.onClose}>Keep draft</button>
          <button className={styles.secondaryButton} disabled={props.saving} onClick={props.onCancel}>Cancel draft</button>
          <button className={styles.primaryButton} disabled={props.saving || (needsMicrosoftInviteConfirm && !props.confirmInvites)} onClick={props.onCreate}><Send aria-hidden="true" /> {props.saving ? "Creating..." : "Create event"}</button>
        </div>
      </section>
    </div>
  );
}

function defaultForm(timezone = "America/Chicago"): CalendarForm {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const end = new Date(now);
  end.setHours(end.getHours() + 1);
  return {
    accountId: "",
    title: "",
    date: dateInput(now),
    startTime: timeInput(now),
    endTime: timeInput(end),
    allDay: false,
    timezone,
    location: "",
    description: "",
    attendees: "",
    reminderMinutes: "",
    isBusy: true,
    privacy: "default",
    sendUpdates: false,
  };
}

function draftPayload(form: CalendarForm) {
  const allDayStart = new Date(`${form.date}T00:00:00`);
  const allDayEnd = addDays(allDayStart, 1);
  const startsAt = form.allDay ? allDayStart.toISOString() : new Date(`${form.date}T${form.startTime}`).toISOString();
  const endsAt = form.allDay ? allDayEnd.toISOString() : new Date(`${form.date}T${form.endTime}`).toISOString();
  return {
    accountId: form.accountId,
    calendarId: "primary",
    title: form.title,
    description: form.description,
    location: form.location,
    startsAt,
    endsAt,
    isAllDay: form.allDay,
    timezone: form.timezone || "America/Chicago",
    attendees: form.attendees,
    reminderMinutes: form.reminderMinutes ? Number(form.reminderMinutes) : null,
    isBusy: form.isBusy,
    privacy: form.privacy,
    sendUpdates: form.sendUpdates,
  };
}

function groupEventsByDay(events: CalendarEvent[], days: Date[], timezone?: string) {
  const map = new Map<string, CalendarEvent[]>();
  for (const day of days) {
    const overlapping = events.filter((event) => calendarEventOverlapsDay(event, day, timezone));
    if (overlapping.length) map.set(dayKey(day), overlapping);
  }
  return map;
}

function addDays(value: Date, days: number) { const next = new Date(value); next.setDate(next.getDate() + days); return next; }
function dayKey(value: Date) { return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`; }
function isSameDay(left: Date, right: Date) { return dayKey(left) === dayKey(right); }
function dateInput(value: Date) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function timeInput(value: Date) { return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`; }
function formatDayHeading(value: Date) { return value.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }); }
function shortWeekday(value: Date) { return value.toLocaleDateString("en-US", { weekday: "short" }); }
function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatTime(value: string) { return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
function formatDate(value: string) { return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function formatDateTime(value: string) { return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function relativeTime(value: string) { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000)); if (minutes < 60) return `${Math.max(1, minutes)}m ago`; if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`; return `${Math.round(minutes / 1_440)}d ago`; }
