import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Github,
  Languages,
  LogIn,
  LogOut,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Star,
  Sun,
  Trash2,
  User,
  X
} from "lucide-react";
import type { BriefingConfig, BriefingItem } from "@lownoise/core";
import { personalNewsBriefing } from "@lownoise/core";
import {
  addPublicTelegramSource,
  deleteBriefing,
  deleteSource,
  forgotPassword,
  getBriefings,
  getFeed,
  getHealth,
  getSession,
  getSources,
  listAccounts,
  login,
  logout,
  refreshPublicTelegramSources,
  register,
  resetPassword,
  retryProcessing,
  saveBriefing,
  searchFeed,
  setFeedStar,
  setSourceEnabled,
  setupAdmin,
  updateAccount,
  updateAdminAccount,
  verifyEmail,
  type SourceIngestResult,
  type SourceRefreshResult
} from "./api";
import { deriveBriefingSlug, formatTime, publicFeedUrl, slugify } from "./helpers";
import type { AccountRecord, AccountWithStats, FeedPayload, HealthStatus, SessionStatus, TelegramSourceRecord } from "./types";
import "./styles.css";

function App() {
  const path = window.location.pathname;
  if (path === "/verify-email") return <VerifyEmailPage token={new URLSearchParams(window.location.search).get("token") ?? ""} />;
  if (path === "/reset-password") return <ResetPasswordPage token={new URLSearchParams(window.location.search).get("token") ?? ""} />;
  const feedMatch = path.match(/^\/([^/.][^/]*)\/([^/]+)\/?$/);
  if (feedMatch && !["api", "admin", "auth", "feed"].includes(feedMatch[1])) {
    return <FeedPage username={decodeURIComponent(feedMatch[1])} slug={decodeURIComponent(feedMatch[2])} />;
  }
  return <AdminPage />;
}

function languageLabel(language: "en" | "ar" | "fr"): string {
  if (language === "ar") return "arabic";
  if (language === "fr") return "french";
  return "english";
}

function AdminPage() {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [briefings, setBriefings] = useState<BriefingConfig[]>([]);
  const [selectedBriefingId, setSelectedBriefingId] = useState<string | null>(null);
  const [sources, setSources] = useState<TelegramSourceRecord[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [accounts, setAccounts] = useState<AccountWithStats[]>([]);
  const [status, setStatus] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const selectedBriefingIdRef = useRef<string | null>(null);

  const account = session?.account ?? null;
  const briefing = briefings.find((item) => item.id === selectedBriefingId) ?? null;
  const orderedBriefings = sortBriefings(briefings);
  const previewSlug = briefing ? deriveBriefingSlug(briefings, briefing.title, briefing.id) : "";

  useEffect(() => {
    selectedBriefingIdRef.current = selectedBriefingId;
  }, [selectedBriefingId]);

  useEffect(() => {
    getSession()
      .then(async (nextSession) => {
        setSession(nextSession);
        if (nextSession.authenticated) {
          await loadBriefings();
          if (nextSession.account?.role === "admin") setAccounts(await listAccounts());
        }
      })
      .catch((cause) => setError(String(cause)));
  }, []);

  useEffect(() => {
    if (!selectedBriefingId || !session?.authenticated) return;
    loadScopedData(selectedBriefingId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause))
    );
  }, [selectedBriefingId, session?.authenticated]);

  async function refreshSession() {
    const next = await getSession();
    setSession(next);
    return next;
  }

  async function loadBriefings(preferredId?: string) {
    const nextBriefings = await getBriefings();
    setBriefings(nextBriefings);
    const activeId =
      preferredId && nextBriefings.some((item) => item.id === preferredId)
        ? preferredId
        : nextBriefings[0]?.id ?? null;
    setSelectedBriefingId(activeId);
  }

  async function loadScopedData(briefingId: string) {
    const [nextSources, nextHealth] = await Promise.all([getSources(briefingId), getHealth(briefingId)]);
    setSources(nextSources);
    setHealth(nextHealth);
  }

  async function persistBriefing(nextBriefing: BriefingConfig, nextStatus = "saved"): Promise<BriefingConfig> {
    setError("");
    setStatus("saving");
    setBusyAction("save-feed");
    try {
      const saved = await saveBriefing(prepareBriefingForSave(nextBriefing, briefings));
      setBriefings((current) => updateBriefingList(current, saved));
      setSelectedBriefingId(saved.id);
      setStatus(nextStatus);
      return saved;
    } finally {
      setBusyAction(null);
    }
  }

  async function createBriefing() {
    if (!account) return;
    setError("");
    setBusyAction("create-feed");
    try {
      const draft = createBriefingDraft(briefings, account);
      const created = await persistBriefing(draft, "feed created");
      await loadBriefings(created.id);
    } finally {
      setBusyAction(null);
    }
  }

  async function copyPublicFeedUrl(nextBriefing: BriefingConfig) {
    if (!nextBriefing.publicFeedEnabled) {
      setStatus("enable public feed first");
      return;
    }
    await navigator.clipboard.writeText(publicFeedUrl(nextBriefing.ownerUsername, nextBriefing.slug));
    setStatus("public feed url copied");
  }

  async function handleLogout() {
    setAccountDialogOpen(false);
    await logout();
    setSession({ authenticated: false, setupRequired: false });
    setBriefings([]);
    setSelectedBriefingId(null);
    setSources([]);
    setHealth(null);
    setAccounts([]);
  }

  const accountDialog = account && accountDialogOpen ? (
    <AccountDialog
      account={account}
      onClose={() => setAccountDialogOpen(false)}
      onLogout={handleLogout}
      onSaved={async (nextAccount, nextBriefings, message) => {
        setSession((current) => (current ? { ...current, account: nextAccount } : current));
        setBriefings(nextBriefings);
        setStatus(message);
        if (selectedBriefingIdRef.current) await loadScopedData(selectedBriefingIdRef.current);
        if (nextAccount.role === "admin") setAccounts(await listAccounts());
        else setAccounts([]);
      }}
    />
  ) : null;

  function patchSelectedBriefing(patch: Partial<BriefingConfig>) {
    if (!briefing) return;
    setBriefings((current) =>
      current.map((item) => (item.id === briefing.id ? { ...item, ...patch } : item))
    );
  }

  if (!session) {
    return (
      <Shell title="admin">
        <p className="muted">loading</p>
      </Shell>
    );
  }

  if (!session.authenticated) {
    return (
      <Shell title="LowNoise.news">
        <AuthPanel
          setupRequired={session.setupRequired}
          onAuthenticated={async () => {
            const next = await refreshSession();
            if (next.authenticated) {
              await loadBriefings();
              if (next.account?.role === "admin") setAccounts(await listAccounts());
            }
          }}
        />
        {error ? <p className="error">{error}</p> : null}
      </Shell>
    );
  }

  if (!account) {
    return (
      <Shell title="admin" onLogout={handleLogout}>
        <p className="error">session account unavailable</p>
      </Shell>
    );
  }

  if (!briefing) {
    return (
      <>
        <Shell title="admin" onAccount={() => setAccountDialogOpen(true)}>
          <section className="section">
            <div className="section-title">
              <Globe size={16} aria-hidden />
              <h2>feeds</h2>
            </div>
            <button type="button" onClick={() => createBriefing()}>
              <Plus size={15} aria-hidden /> new feed
            </button>
          </section>
        </Shell>
        {accountDialog}
      </>
    );
  }

  return (
    <>
      <Shell title="admin" onAccount={() => setAccountDialogOpen(true)} feed={briefing}>
        <div className="admin-stack">
          <section className="section">
            <div className="section-title">
              <Globe size={16} aria-hidden />
              <h2>feeds</h2>
            </div>
            <div className="actions">
              <button type="button" disabled={busyAction === "create-feed"} onClick={() => createBriefing()}>
                <Plus size={15} aria-hidden /> new feed
              </button>
              {status ? <span className="muted">{status}</span> : null}
            </div>
            <div className="feed-list">
              {orderedBriefings.map((item) => (
                <div key={item.id} className={`feed-row${item.id === briefing.id ? " active" : ""}`}>
                  <button type="button" className="feed-select" onClick={() => setSelectedBriefingId(item.id)}>
                    <span className="feed-title">{item.title}</span>
                  </button>
                  <div className="feed-flags">
                    <span className="star-count"><Star size={13} aria-hidden /> {item.stars}</span>
                    <span className="pill">{languageLabel(item.language)}</span>
                    <span className="pill">{item.publicFeedEnabled ? "public" : "private"}</span>
                    {item.paused ? <span className="pill">paused</span> : null}
                  </div>
                  <a className="button-link" href={`/${item.ownerUsername}/${item.slug}/`}>open</a>
                  <button type="button" disabled={!item.publicFeedEnabled} onClick={() => copyPublicFeedUrl(item)}>
                    <Copy size={15} aria-hidden /> copy url
                  </button>
                </div>
              ))}
            </div>
          </section>

          <div className="admin-grid">
            <form
              className="section"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await persistBriefing(briefing);
                } catch (cause) {
                  setStatus("");
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
            >
            <div className="section-title">
              <Settings size={16} aria-hidden />
              <h2>setup</h2>
            </div>
            <label>
              title
              <input dir="ltr" value={briefing.title} onChange={(event) => patchSelectedBriefing({ title: event.target.value })} />
            </label>
            <div className="field-group">
              <span>slug</span>
              <code className="generated-slug">/{briefing.ownerUsername}/{previewSlug}/</code>
            </div>
            <div className="field-group">
              <span>language</span>
              <div className="segmented" role="group" aria-label="feed language">
                {(["en", "fr", "ar"] as const).map((language) => (
                  <button
                    key={language}
                    type="button"
                    className={briefing.language === language ? "active" : ""}
                    onClick={() => patchSelectedBriefing({ language })}
                  >
                    <Languages size={15} aria-hidden /> {languageLabel(language)}
                  </button>
                ))}
              </div>
            </div>
            <label>
              interest profile
              <textarea
                dir="ltr"
                required
                rows={6}
                value={briefing.interestProfile}
                onChange={(event) => patchSelectedBriefing({ interestProfile: event.target.value })}
              />
            </label>
            <label>
              style instruction
              <textarea
                dir="ltr"
                rows={3}
                value={briefing.styleInstruction ?? ""}
                onChange={(event) => patchSelectedBriefing({ styleInstruction: event.target.value })}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={briefing.publicFeedEnabled}
                onChange={(event) => patchSelectedBriefing({ publicFeedEnabled: event.target.checked })}
              />
              public feed
            </label>
            <details>
              <summary>advanced</summary>
              <label>
                retention days
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={briefing.retentionDays}
                  onChange={(event) => patchSelectedBriefing({ retentionDays: Number(event.target.value) })}
                />
              </label>
            </details>
            <div className="actions">
              <button type="submit"><Save size={15} aria-hidden /> save</button>
              <button
                type="button"
                disabled={busyAction === "pause-feed"}
                onClick={async () => {
                  try {
                    await persistBriefing({ ...briefing, paused: !briefing.paused }, briefing.paused ? "feed resumed" : "feed paused");
                  } catch (cause) {
                    setStatus("");
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              >
                {briefing.paused ? <Play size={15} aria-hidden /> : <Pause size={15} aria-hidden />}
                {briefing.paused ? "resume feed" : "pause feed"}
              </button>
              <a className="button-link" href={`/${briefing.ownerUsername}/${briefing.slug}/`}>open feed</a>
              <button type="button" disabled={!briefing.publicFeedEnabled} onClick={() => copyPublicFeedUrl(briefing)}>
                <Copy size={15} aria-hidden /> copy public url
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={briefings.length <= 1 || busyAction === "delete-feed"}
                onClick={async () => {
                  if (briefings.length <= 1) return;
                  if (!window.confirm(`Delete "${briefing.title}" and all of its sources and published items?`)) return;
                  const remaining = await deleteBriefing(briefing.id);
                  setBriefings(remaining);
                  setSelectedBriefingId(remaining[0]?.id ?? null);
                  setStatus("feed deleted");
                }}
              >
                <Trash2 size={15} aria-hidden /> delete feed
              </button>
            </div>
            {error ? <p className="error">{error}</p> : null}
            </form>

            <section className="section">
            <div className="section-title">
              <RefreshCw size={16} aria-hidden />
              <h2>sources</h2>
            </div>
            <div className="source-add">
              <label>
                telegram channel url
                <input dir="ltr" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://t.me/LebUpdate" />
              </label>
              <button
                type="button"
                disabled={!sourceUrl.trim() || briefing.paused || busyAction === "add-source"}
                onClick={async () => {
                  setError("");
                  try {
                    setBusyAction("add-source");
                    setSourceStatus("fetching the public Telegram page and queuing matching posts");
                    const response = await addPublicTelegramSource(briefing.id, sourceUrl);
                    applySourceResponse(response);
                    setSourceUrl("");
                    setStatus("source added");
                    void pollHealthUntilSettled(briefing.id, response.health);
                  } catch (cause) {
                    setStatus("");
                    setError(cause instanceof Error ? cause.message : String(cause));
                    setSourceStatus("");
                  } finally {
                    setBusyAction(null);
                  }
                }}
              >
                <Plus size={15} aria-hidden /> add
              </button>
            </div>
            <div className="actions">
              <button
                type="button"
                disabled={briefing.paused || busyAction === "refresh-source"}
                onClick={async () => {
                  setError("");
                  try {
                    setBusyAction("refresh-source");
                    setSourceStatus("fetching enabled channels");
                    const response = await refreshPublicTelegramSources(briefing.id);
                    applySourceResponse(response);
                    setStatus("latest fetched");
                    void pollHealthUntilSettled(briefing.id, response.health);
                  } catch (cause) {
                    setStatus("");
                    setError(cause instanceof Error ? cause.message : String(cause));
                    setSourceStatus("");
                  } finally {
                    setBusyAction(null);
                  }
                }}
              >
                <RefreshCw size={15} aria-hidden /> fetch latest
              </button>
              <button
                type="button"
                disabled={busyAction === "retry-processing"}
                onClick={async () => {
                  setBusyAction("retry-processing");
                  const response = await retryProcessing(briefing.id);
                  setHealth(response.health);
                  setStatus(response.retried > 0 ? `retried ${response.retried} job(s)` : "no stale jobs to retry");
                  setBusyAction(null);
                }}
              >
                <RefreshCw size={15} aria-hidden /> retry processing
              </button>
            </div>
            {sourceStatus ? <p className="muted section-note">{sourceStatus}</p> : null}
            <div className="health">
              <StatusLine label="processing" value={`queued ${health?.processing.queued ?? 0} / failed ${health?.processing.failed ?? 0}`} />
              <StatusLine label="last source event" value={health?.lastTelegramEventAt ?? "none"} />
              <StatusLine label="latest published" value={health?.latestPublishedAt ? formatTime(health.latestPublishedAt, briefing.language) : "none"} />
              <StatusLine label="status" value={briefing.paused ? "paused" : "live"} />
            </div>
            <div className="source-list">
              {sources.length === 0 ? <p className="muted">add Telegram channel URLs</p> : null}
              {sources.map((source) => (
                <div key={source.id} className="source-row">
                  <div className="source-copy">
                    <label className="source-toggle">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        onChange={async (event) => {
                          setSources(await setSourceEnabled(briefing.id, source.id, event.target.checked));
                          setSourceStatus(event.target.checked ? "source enabled" : "source paused");
                        }}
                      />
                      <span className="source-title" title={source.title}><bdi>{source.title}</bdi></span>
                    </label>
                    {source.url ? <a className="source-link" href={source.url} target="_blank" rel="noreferrer" dir="ltr">{source.username ?? "open"}</a> : null}
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`remove ${source.title}`}
                    onClick={async () => {
                      const response = await deleteSource(briefing.id, source.id);
                      setSources(response.sources);
                      setHealth(response.health);
                      setSourceStatus("source removed");
                    }}
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            </section>
          </div>

          {account.role === "admin" ? (
            <AdminAccountsSection
              accounts={accounts}
              onAccountsChanged={(nextAccounts) => setAccounts(nextAccounts)}
            />
          ) : null}
        </div>
      </Shell>
      {accountDialog}
    </>
  );

  function applySourceResponse(response: SourceRefreshResult) {
    setSources(response.sources);
    setHealth(response.health);
    if (response.result) setSourceStatus(formatSourceIngestResult(response.result));
    else if (response.results) setSourceStatus(formatSourceRefreshResults(response.results));
  }

  async function pollHealthUntilSettled(briefingId: string, initialHealth: HealthStatus) {
    let nextHealth = initialHealth;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (selectedBriefingIdRef.current !== briefingId) return;
      if (nextHealth.processing.queued <= 0) {
        setSourceStatus("queue clear");
        return;
      }
      setSourceStatus(`processing ${nextHealth.processing.queued} queued post(s)`);
      await wait(1200);
      nextHealth = await getHealth(briefingId);
      if (selectedBriefingIdRef.current !== briefingId) return;
      setHealth(nextHealth);
    }
  }
}

function AuthPanel(props: { setupRequired: boolean; onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">(props.setupRequired ? "register" : "login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  return (
    <form
      className="login"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        setMessage("");
        try {
          if (props.setupRequired) {
            await setupAdmin({ email, username, password, setupToken });
            await props.onAuthenticated();
            return;
          }
          if (mode === "register") {
            await register({ email, username, password });
            setMessage("check your email to verify your account");
            return;
          }
          if (mode === "forgot") {
            await forgotPassword(email);
            setMessage("if the account exists, a reset email was sent");
            return;
          }
          await login(email, password);
          await props.onAuthenticated();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }}
    >
      {props.setupRequired ? (
        <label>
          setup token
          <input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} />
        </label>
      ) : null}
      <label>
        email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      {(mode === "register" || props.setupRequired) ? (
        <label>
          username
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
      ) : null}
      {mode !== "forgot" ? (
        <label>
          password
          <input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
      ) : null}
      <button type="submit"><LogIn size={15} aria-hidden /> {props.setupRequired ? "create admin" : mode}</button>
      {!props.setupRequired ? (
        <div className="actions">
          <button type="button" onClick={() => setMode("login")}>login</button>
          <button type="button" onClick={() => setMode("register")}>register</button>
          <button type="button" onClick={() => setMode("forgot")}>forgot password</button>
        </div>
      ) : null}
      {message ? <p className="muted">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}

function VerifyEmailPage(props: { token: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="verify email">
      <section className="section notice">
        <p>{message || "confirm this email address"}</p>
        <div className="actions">
          <button
            type="button"
            disabled={busy || !props.token}
            onClick={async () => {
              setBusy(true);
              setMessage("");
              try {
                await verifyEmail(props.token);
                setMessage("email verified");
              } catch (cause) {
                setMessage(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            verify email
          </button>
          <a className="button-link" href="/">admin</a>
        </div>
      </section>
    </Shell>
  );
}

function ResetPasswordPage(props: { token: string }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <Shell title="reset password">
      <form className="login" onSubmit={async (event) => {
        event.preventDefault();
        try {
          await resetPassword(props.token, password);
          setMessage("password reset");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }}>
        <label>
          new password
          <input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button type="submit"><Save size={15} aria-hidden /> save password</button>
        {message ? <p className="muted">{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </form>
    </Shell>
  );
}

function AccountDialog(props: {
  account: AccountRecord;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSaved: (account: AccountRecord, briefings: BriefingConfig[], message: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(props.account.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"username" | "password" | "logout" | null>(null);
  const usernameFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setUsername(props.account.username);
  }, [props.account.username]);

  useEffect(() => {
    usernameFieldRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [props.onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <div className="modal-head">
          <div className="section-title">
            <User size={16} aria-hidden />
            <h2 id="account-dialog-title">account</h2>
          </div>
          <button type="button" className="icon-button" aria-label="close account settings" onClick={props.onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="account-meta">
          <span>{props.account.email}</span>
          <span>{props.account.role}</span>
        </div>

        <form
          className="account-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            setMessage("");
            setBusy("username");
            try {
              const result = await updateAccount({ username });
              await props.onSaved(result.account, result.briefings, "username saved");
              setMessage("username saved");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(null);
            }
          }}
        >
          <label>
            username
            <input ref={usernameFieldRef} value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
          </label>
          <button type="submit" disabled={busy === "username"}>
            <Save size={15} aria-hidden /> save username
          </button>
        </form>

        <form
          className="account-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            setMessage("");
            setBusy("password");
            try {
              const result = await updateAccount({ currentPassword, newPassword });
              await props.onSaved(result.account, result.briefings, "password changed");
              setCurrentPassword("");
              setNewPassword("");
              setMessage("password changed");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(null);
            }
          }}
        >
          <label>
            current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            new password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy === "password"}>
            <Save size={15} aria-hidden /> change password
          </button>
        </form>

        <div className="account-actions">
          <button
            type="button"
            disabled={busy === "logout"}
            onClick={async () => {
              setBusy("logout");
              await props.onLogout();
            }}
          >
            <LogOut size={15} aria-hidden /> logout
          </button>
          {message ? <p className="muted">{message}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </div>
      </section>
    </div>
  );
}

function AdminAccountsSection(props: {
  accounts: AccountWithStats[];
  onAccountsChanged: (accounts: AccountWithStats[]) => void;
}) {
  const [managedAccountId, setManagedAccountId] = useState<string | null>(null);
  const managedAccount = props.accounts.find((account) => account.id === managedAccountId) ?? null;

  return (
    <>
      <section className="section">
        <div className="section-title">
          <User size={16} aria-hidden />
          <h2>accounts</h2>
        </div>
        <div className="source-list">
          {props.accounts.map((account) => (
            <div key={account.id} className="source-row">
              <div className="source-copy">
                <strong>{account.username}</strong>
                <span className="muted">{account.email} / {account.role} / feeds {account.briefingCount}</span>
                <span className="muted">{account.disabledAt ? "disabled" : account.emailVerifiedAt ? "verified" : "unverified"}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`manage ${account.username}`}
                onClick={() => setManagedAccountId(account.id)}
              >
                <Settings size={15} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </section>
      {managedAccount ? (
        <AdminAccountDialog
          account={managedAccount}
          onClose={() => setManagedAccountId(null)}
          onAccountsChanged={props.onAccountsChanged}
        />
      ) : null}
    </>
  );
}

function AdminAccountDialog(props: {
  account: AccountWithStats;
  onClose: () => void;
  onAccountsChanged: (accounts: AccountWithStats[]) => void;
}) {
  const [username, setUsername] = useState(props.account.username);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"username" | "role" | "disabled" | null>(null);
  const usernameFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setUsername(props.account.username);
  }, [props.account.username]);

  useEffect(() => {
    usernameFieldRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [props.onClose]);

  async function updateAccountAndRefresh(input: { username?: string; role?: "admin" | "user"; disabled?: boolean }, nextMessage: string) {
    setError("");
    setMessage("");
    const result = await updateAdminAccount(props.account.id, input);
    props.onAccountsChanged(result.accounts);
    setMessage(nextMessage);
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="admin-account-dialog-title">
        <div className="modal-head">
          <div className="section-title">
            <User size={16} aria-hidden />
            <h2 id="admin-account-dialog-title">manage account</h2>
          </div>
          <button type="button" className="icon-button" aria-label="close account management" onClick={props.onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="account-meta">
          <span>{props.account.email}</span>
          <span>{props.account.disabledAt ? "disabled" : props.account.emailVerifiedAt ? "verified" : "unverified"}</span>
          <span>{props.account.briefingCount} feed{props.account.briefingCount === 1 ? "" : "s"}</span>
        </div>

        <form
          className="account-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy("username");
            try {
              await updateAccountAndRefresh({ username }, "username saved");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(null);
            }
          }}
        >
          <label>
            username
            <input ref={usernameFieldRef} value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <button type="submit" disabled={busy === "username"}>
            <Save size={15} aria-hidden /> save username
          </button>
        </form>

        <div className="account-form">
          <div className="field-group">
            <span>role</span>
            <div className="segmented" role="group" aria-label={`role for ${props.account.username}`}>
              {(["user", "admin"] as const).map((role) => (
                <button
                  key={role}
                  type="button"
                  className={props.account.role === role ? "active" : ""}
                  disabled={busy === "role"}
                  aria-pressed={props.account.role === role}
                  onClick={async () => {
                    if (props.account.role === role) return;
                    setBusy("role");
                    try {
                      await updateAccountAndRefresh({ role }, `role changed to ${role}`);
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {role}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={props.account.disabledAt ? "" : "danger-button"}
            disabled={busy === "disabled"}
            onClick={async () => {
              setBusy("disabled");
              try {
                await updateAccountAndRefresh(
                  { disabled: !props.account.disabledAt },
                  props.account.disabledAt ? "account enabled" : "account disabled"
                );
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(null);
              }
            }}
          >
            {props.account.disabledAt ? "enable account" : "disable account"}
          </button>
        </div>

        {message ? <p className="muted">{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </div>
  );
}

function FeedPage(props: { username: string; slug: string }) {
  const [payload, setPayload] = useState<FeedPayload | null>(null);
  const [items, setItems] = useState<BriefingItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [starBusy, setStarBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  async function refresh() {
    setError("");
    const next = await getFeed(props.username, props.slug);
    setPayload(next);
    setItems(next.items);
  }

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [props.username, props.slug]);

  useEffect(() => {
    const raw = localStorage.getItem(`ln_read:${props.username}:${props.slug}`);
    setReadIds(new Set(raw ? (JSON.parse(raw) as string[]) : []));
  }, [props.username, props.slug]);

  useEffect(() => {
    localStorage.setItem(`ln_read:${props.username}:${props.slug}`, JSON.stringify(Array.from(readIds)));
  }, [props.username, props.slug, readIds]);

  useEffect(() => {
    if (!payload) return;
    let active = true;
    const timeout = window.setTimeout(async () => {
      try {
        setError("");
        const nextItems = query.trim() ? await searchFeed(props.username, props.slug, query) : payload.items;
        if (active) setItems(nextItems);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [payload, props.username, props.slug, query]);

  const unreadItems = items.filter((item) => !readIds.has(item.id));
  const archivedReadItems = items.filter((item) => readIds.has(item.id));
  const language = payload?.briefing.language ?? "en";
  const canStar = Boolean(payload?.briefing.publicFeedEnabled);

  return (
    <Shell title={payload?.briefing.title ?? "briefing"} feed={payload?.briefing} pageLanguage={language}>
      <div className="feed-tools">
        <div className="feed-actions">
          <button onClick={() => refresh()}><RefreshCw size={15} aria-hidden /> refresh</button>
          <button
            type="button"
            className={`star-vote${payload?.viewerHasStarred ? " is-starred" : ""}`}
            disabled={!canStar || starBusy || !payload}
            aria-pressed={payload?.viewerHasStarred ?? false}
            onClick={async () => {
              if (!payload) return;
              setStarBusy(true);
              try {
                const result = await setFeedStar(props.username, props.slug, !payload.viewerHasStarred);
                setPayload({
                  ...payload,
                  briefing: { ...payload.briefing, stars: result.stars },
                  viewerHasStarred: result.viewerHasStarred
                });
              } finally {
                setStarBusy(false);
              }
            }}
          >
            <Star size={15} aria-hidden />
            {payload?.viewerHasStarred ? "starred" : "star"} {payload?.briefing.stars ?? 0}
          </button>
        </div>
        <form
          className="search"
          onSubmit={async (event) => {
            event.preventDefault();
            setItems(query.trim() ? await searchFeed(props.username, props.slug, query) : payload?.items ?? []);
          }}
        >
          <Search size={15} aria-hidden />
          <input aria-label="search published briefing" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search published briefing" />
        </form>
      </div>
      {error ? <FeedNotice message={error} /> : null}
      <div className="news-line">
        {unreadItems.map((item) => (
          <FeedItemRow
            key={item.id}
            item={item}
            language={language}
            isExpanded={expanded.has(item.id)}
            isRead={false}
            onToggleExpanded={() => toggleSetValue(expanded, setExpanded, item.id)}
            onToggleRead={() => toggleRead(readIds, setReadIds, item.id, true)}
          />
        ))}
        {unreadItems.length === 0 && !error ? (
          <div className="empty-state">
            <strong>{archivedReadItems.length > 0 ? "all visible items are read" : "no published items"}</strong>
            <p className="muted">
              {archivedReadItems.length > 0 ? "Open the read section below to revisit archived lines." : "The briefing line fills after enabled Telegram sources publish matching items."}
            </p>
          </div>
        ) : null}
      </div>
      {archivedReadItems.length > 0 ? (
        <details className="section read-section">
          <summary>read {archivedReadItems.length}</summary>
          <div className="news-line news-line-read">
            {archivedReadItems.map((item) => (
              <FeedItemRow
                key={item.id}
                item={item}
                language={language}
                isExpanded={expanded.has(item.id)}
                isRead={true}
                onToggleExpanded={() => toggleSetValue(expanded, setExpanded, item.id)}
                onToggleRead={() => toggleRead(readIds, setReadIds, item.id, false)}
              />
            ))}
          </div>
        </details>
      ) : null}
    </Shell>
  );
}

function FeedItemRow(props: {
  item: BriefingItem;
  language: "en" | "ar" | "fr";
  isExpanded: boolean;
  isRead: boolean;
  onToggleExpanded: () => void;
  onToggleRead: () => void;
}) {
  return (
    <article className="news-item">
      <button type="button" className="read-button" aria-label={props.isRead ? `mark ${props.item.summary} unread` : `mark ${props.item.summary} read`} onClick={props.onToggleRead}>
        {props.isRead ? "unread" : "read"}
      </button>
      <button type="button" className="expand" aria-expanded={props.isExpanded} aria-label={`show evidence for ${props.item.summary}`} onClick={props.onToggleExpanded}>
        {props.isExpanded ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
      </button>
      <div className="news-copy" lang={props.language}>
        <div className="news-meta">
          <time dateTime={props.item.itemAt} dir="ltr">{formatTime(props.item.itemAt, props.language)}</time>
          {props.item.mergedUpdateCount > 0 ? <span className="muted">updates {props.item.mergedUpdateCount + 1}</span> : null}
        </div>
        <p className="news-summary"><bdi>{props.item.summary}</bdi></p>
        {props.isExpanded ? <EvidenceList item={props.item} language={props.language} /> : null}
      </div>
    </article>
  );
}

function EvidenceList(props: { item: BriefingItem; language: "en" | "ar" | "fr" }) {
  return (
    <div className="evidence">
      {props.item.evidence.map((entry) => (
        <div key={entry.messageId} className="evidence-row">
          <div className="evidence-head">
            <strong className="evidence-title"><bdi>{entry.sourceTitle}</bdi></strong>
            <time dateTime={entry.postedAt} dir="ltr">{formatTime(entry.postedAt, props.language)}</time>
          </div>
          <p className="evidence-text"><bdi>{entry.text}</bdi></p>
          <div className="evidence-links">
            {entry.sourceUrl ? <a href={entry.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden /> original</a> : null}
            {entry.links.map((link) => <a key={link} href={link} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden /> link</a>)}
            {entry.media.map((media, index) =>
              media.url ? (
                <a key={`${media.url}-${index}`} href={media.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} aria-hidden /> {media.label ?? media.type}
                </a>
              ) : (
                <span key={`${media.fileId}-${index}`} className="muted">{media.label ?? media.type}</span>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusLine(props: { label: string; value: string }) {
  return (
    <p className="status-line">
      <span className="status-label">{props.label}</span>
      <span className="status-value">{props.value}</span>
    </p>
  );
}

function FeedNotice(props: { message: string }) {
  return (
    <section className="section notice">
      <h2>feed unavailable</h2>
      <p>{props.message}</p>
    </section>
  );
}

function Shell(props: {
  title: string;
  children: React.ReactNode;
  feed?: Pick<BriefingConfig, "ownerUsername" | "slug" | "title">;
  onAccount?: () => void;
  onLogout?: () => Promise<void>;
  pageLanguage?: "en" | "ar" | "fr";
}) {
  const [theme, setTheme] = useState(() => localStorage.getItem("ln_theme") ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ln_theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = props.pageLanguage ?? "en";
    document.title = props.title === "LowNoise.news" ? "LowNoise.news" : `${props.title} · LowNoise.news`;
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (manifest) {
      manifest.href = props.feed
        ? `/manifest.webmanifest?user=${encodeURIComponent(props.feed.ownerUsername)}&feed=${encodeURIComponent(props.feed.slug)}`
        : "/manifest.webmanifest";
    }
  }, [props.feed, props.pageLanguage, props.title]);

  return (
    <main className="shell">
      <header>
        <div className="header-primary">
          <div className="brand-lockup">
            <a href="/" className="brand">LowNoise.news</a>
            <a href="https://github.com/AmmarMohanna/lownoise.news" target="_blank" rel="noreferrer" className="brand-icon" aria-label="Open GitHub repository">
              <Github size={16} aria-hidden />
            </a>
          </div>
        </div>
        <div className="header-actions">
          <nav>
            <a href="/">admin</a>
            {props.feed ? <a href={`/${props.feed.ownerUsername}/${props.feed.slug}/`}>feed</a> : null}
          </nav>
          <div className="header-controls">
            {props.onAccount ? (
              <button type="button" className="icon-button" aria-label="account settings" onClick={props.onAccount}>
                <Settings size={16} aria-hidden />
              </button>
            ) : null}
            <button type="button" className="icon-button" aria-label={`switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
              {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
            </button>
            {props.onLogout ? <button type="button" onClick={() => void props.onLogout?.()}><LogOut size={15} aria-hidden /> logout</button> : null}
          </div>
        </div>
      </header>
      <div className="page-heading">
        <h1>{props.title}</h1>
        <p>{getPageMeta(props.title)}</p>
      </div>
      {props.children}
    </main>
  );
}

function getPageMeta(title: string): string {
  if (title === "admin") return "Define the feed and review sources.";
  if (title === "briefing") return "Published briefing items only.";
  if (title.includes("Briefing")) return "Published briefing items only.";
  if (title === "verify email") return "Account verification.";
  if (title === "reset password") return "Account recovery.";
  return "Self-hosted news filtering.";
}

function updateBriefingList(current: BriefingConfig[], next: BriefingConfig): BriefingConfig[] {
  const exists = current.some((item) => item.id === next.id);
  if (!exists) return [...current, next];
  return current.map((item) => (item.id === next.id ? next : item));
}

function createBriefingDraft(existing: BriefingConfig[], account: AccountRecord): BriefingConfig {
  const nextIndex = existing.length + 1;
  const title = nextIndex === 1 ? "Personal Briefing" : `Briefing ${nextIndex}`;
  return {
    ...personalNewsBriefing,
    id: `briefing_${crypto.randomUUID()}`,
    ownerAccountId: account.id,
    ownerUsername: account.username,
    title,
    slug: deriveBriefingSlug(existing, title),
    publicFeedEnabled: false,
    paused: false,
    language: "en",
    stars: 0
  };
}

function toggleSetValue(
  current: Set<string>,
  setValue: React.Dispatch<React.SetStateAction<Set<string>>>,
  id: string
) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setValue(next);
}

function toggleRead(
  current: Set<string>,
  setValue: React.Dispatch<React.SetStateAction<Set<string>>>,
  id: string,
  read: boolean
) {
  const next = new Set(current);
  if (read) next.add(id);
  else next.delete(id);
  setValue(next);
}

function formatSourceIngestResult(result: SourceIngestResult): string {
  if (result.imported === 0 && result.skipped > 0) return `checked ${result.fetched}, no new posts`;
  return `fetched ${result.fetched}, queued ${result.queued}`;
}

function formatSourceRefreshResults(results: SourceIngestResult[]): string {
  const totals = results.reduce(
    (sum, result) => ({
      fetched: sum.fetched + result.fetched,
      imported: sum.imported + result.imported,
      queued: sum.queued + result.queued,
      skipped: sum.skipped + result.skipped
    }),
    { fetched: 0, imported: 0, queued: 0, skipped: 0 }
  );
  if (totals.fetched === 0) return "no enabled channel URLs to refresh";
  if (totals.imported === 0 && totals.skipped > 0) return `checked ${totals.fetched}, no new posts`;
  return `fetched ${totals.fetched}, queued ${totals.queued}`;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function prepareBriefingForSave(briefing: BriefingConfig, existing: BriefingConfig[]): BriefingConfig {
  const nextSlug = deriveBriefingSlug(existing, briefing.title, briefing.id);
  return { ...briefing, slug: slugify(nextSlug) };
}

function sortBriefings(briefings: BriefingConfig[]): BriefingConfig[] {
  return [...briefings].sort((left, right) => {
    if (left.stars !== right.stars) return right.stars - left.stars;
    return left.title.localeCompare(right.title);
  });
}

createRoot(document.getElementById("root")!).render(<App />);
