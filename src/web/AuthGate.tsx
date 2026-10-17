import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authApi, passkeyErrorMessage, UNAUTHENTICATED_EVENT, type AuthState } from "./auth-api";

export const authStateKey = ["auth-session"] as const;

interface OwnerContextValue {
  readonly desktop: boolean;
  readonly passkeys: boolean;
  readonly signOut: () => Promise<void>;
}

const OwnerContext = createContext<OwnerContextValue>({ desktop: false, passkeys: false, signOut: async () => undefined });

export function useOwner(): OwnerContextValue {
  return useContext(OwnerContext);
}

const passkeysUnavailable = "Passkeys need a domain name over a secure connection: open Postreeve at http://localhost or at its public https address.";

/** Shows setup, sign-in or the application, depending on the owner session. */
export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: authStateKey, queryFn: authApi.state, staleTime: Infinity, retry: 1 });
  const [offerPasskey, setOfferPasskey] = useState(false);

  useEffect(() => {
    const onUnauthenticated = () => void queryClient.invalidateQueries({ queryKey: authStateKey });
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [queryClient]);

  const signedIn = async () => {
    // Drop everything cached under a previous session before the application mounts again.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== authStateKey[0] });
    await queryClient.invalidateQueries({ queryKey: authStateKey });
  };

  if (state.isPending) return <AuthFrame title="Postreeve"><p className="t-dim">Loading…</p></AuthFrame>;
  if (state.isError) {
    return <AuthFrame title="Postreeve is unreachable">
      <p className="t-body">{state.error.message}</p>
      <button className="btn" onClick={() => void state.refetch()}>Try again</button>
    </AuthFrame>;
  }

  const current: AuthState = state.data;
  if (current.state === "setup") {
    return <SetupScreen onDone={async () => { setOfferPasskey(current.passkeys); await signedIn(); }} />;
  }
  if (current.state === "login") return <LoginScreen state={current} onDone={signedIn} />;
  if (offerPasskey) return <PasskeyOffer onDone={() => setOfferPasskey(false)} />;

  const value: OwnerContextValue = {
    desktop: current.desktop,
    passkeys: current.passkeys,
    signOut: async () => {
      await authApi.logout().catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: authStateKey });
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== authStateKey[0] });
    },
  };
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return <main className="auth-screen">
    <div className="auth-card">
      <span className="brand">POSTREEVE</span>
      <h1 className="auth-title">{title}</h1>
      {children}
    </div>
  </main>;
}

function SetupScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.setup(setupToken, password);
      await onDone();
    } catch (cause) {
      setError(passkeyErrorMessage(cause));
      setBusy(false);
    }
  };

  return <AuthFrame title="Set up Postreeve">
    <p className="t-body">
      This instance has no owner yet. Enter the setup token from <code>POSTREEVE_SETUP_TOKEN</code>, or the one
      the server printed to its log at startup, and choose a password. You can add a passkey next.
    </p>
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label className="field"><span className="field-label">Setup token</span>
        <input className="input" autoComplete="off" spellCheck={false} value={setupToken} onChange={(event) => setSetupToken(event.target.value)} />
      </label>
      <label className="field"><span className="field-label">Password</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label className="field"><span className="field-label">Repeat password</span>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </label>
      <p className="t-dim">At least 12 characters. The password stays as a fallback when a passkey is not at hand.</p>
      {mismatch ? <div className="alert error">The passwords do not match.</div> : null}
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      <button className="btn" disabled={busy || !setupToken.trim() || password.length < 12 || password !== confirm}>Create owner</button>
    </form>
  </AuthFrame>;
}

function LoginScreen({ state, onDone }: { state: Extract<AuthState, { state: "login" }>; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onDone();
    } catch (cause) {
      setError(passkeyErrorMessage(cause));
      setBusy(false);
    }
  };

  return <AuthFrame title="Sign in">
    {state.passkeys && state.hasPasskeys
      ? <button className="btn auth-primary" disabled={busy} onClick={() => void run(authApi.loginWithPasskey)}>Sign in with a passkey</button>
      : null}
    {!state.passkeys ? <p className="t-dim">{passkeysUnavailable}</p> : null}
    <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void run(() => authApi.loginWithPassword(password)); }}>
      <label className="field"><span className="field-label">Password</span>
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      <button className={state.passkeys && state.hasPasskeys ? "chip" : "btn"} disabled={busy || !password}>Sign in with password</button>
    </form>
  </AuthFrame>;
}

function PasskeyOffer({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState(defaultPasskeyName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.addPasskey(name.trim());
      onDone();
    } catch (cause) {
      setError(passkeyErrorMessage(cause));
      setBusy(false);
    }
  };

  return <AuthFrame title="Add a passkey">
    <p className="t-body">
      A passkey signs you in with this device's screen lock or a security key, and cannot be phished. Your password
      keeps working as a fallback.
    </p>
    <form className="auth-form" onSubmit={(event) => void add(event)}>
      <label className="field"><span className="field-label">Passkey name</span>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
      </label>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      <div className="auth-actions">
        <button className="btn" disabled={busy || !name.trim()}>Add passkey</button>
        <button type="button" className="btn-quiet" disabled={busy} onClick={onDone}>Not now</button>
      </div>
    </form>
  </AuthFrame>;
}

export function defaultPasskeyName(): string {
  const agent = navigator.userAgent;
  const platform = /iPhone|iPad/.test(agent) ? "iPhone or iPad"
    : /Macintosh/.test(agent) ? "Mac"
      : /Android/.test(agent) ? "Android"
        : /Windows/.test(agent) ? "Windows"
          : /Linux/.test(agent) ? "Linux" : "This device";
  return `${platform} passkey`;
}
