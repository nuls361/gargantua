import { useEffect, useState } from "react";
import { Routes, Route, NavLink, Navigate, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Lists from "./pages/Lists";
import Import from "./pages/Import";
import RecycleList from "./pages/RecycleList";
import CommandK from "./components/CommandK";
import Leads from "./pages/Leads";
import Campaigns from "./pages/Campaigns";
import Hashtags from "./pages/Hashtags";
import Creators from "./pages/Creators";
import Brands from "./pages/Brands";
import Sounds from "./pages/Sounds";
import Seeds from "./pages/Seeds";
import Harvest from "./pages/Harvest";
import Jobs from "./pages/Jobs";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) {
    return <div className="center-loading">Loading…</div>;
  }

  // Invited user (or password reset) arrived via an email link -> set a password.
  if (recovery) {
    return <SetPassword onDone={() => setRecovery(false)} />;
  }

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <div className="app-shell">
      <CommandK />
      <Sidebar email={session.user.email ?? ""} />
      <div className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<Jobs />} />
          <Route path="/lists" element={<Lists />} />
          <Route path="/lists/recycle" element={<RecycleList />} />
          <Route path="/lists/:id" element={<Lists />} />
          <Route path="/import" element={<Import />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<Campaigns />} />
          <Route path="/search" element={<Creators />} />
          <Route path="/harvest" element={<Harvest />} />
          <Route path="/brands" element={<Brands />} />
          <Route path="/hashtags" element={<Hashtags />} />
          <Route path="/sounds" element={<Sounds />} />
          <Route path="/seeds" element={<Seeds />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function SetPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setError(error.message);
    else onDone();
  }

  return (
    <div className="login-wrap">
      <div className="panel">
        <h2>Set password</h2>
        <p className="muted">Choose a password for your account.</p>
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
              style={{ width: "100%" }}
            />
          </div>
          <button className="primary" type="submit" disabled={busy || password.length < 8} style={{ width: "100%" }}>
            {busy ? "…" : "Save password & get started"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Sidebar({ email }: { email: string }) {
  const navigate = useNavigate();
  async function logout() {
    await supabase.auth.signOut();
    navigate("/");
  }
  return (
    <aside className="sidebar">
      <h1>WePush</h1>
      <button
        className="cmdk-trigger"
        onClick={() => window.dispatchEvent(new Event("open-command-k"))}
      >
        Search leads… <kbd>⌘K</kbd>
      </button>
      <nav>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <div className="nav-section">Discover</div>
        <NavLink to="/search">Search</NavLink>
        <NavLink to="/harvest">Harvest</NavLink>
        <div className="nav-section">Pipeline</div>
        <NavLink to="/jobs">Jobs</NavLink>
      </nav>
      <div className="spacer" />
      <nav className="nav-secondary">
        <NavLink to="/import">Import</NavLink>
      </nav>
      <div className="user">{email}</div>
      <button onClick={logout}>Sign out</button>
    </aside>
  );
}
