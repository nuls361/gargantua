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

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) {
    return <div className="center-loading">Loading…</div>;
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
          <Route path="/lists" element={<Lists />} />
          <Route path="/lists/recycle" element={<RecycleList />} />
          <Route path="/lists/:id" element={<Lists />} />
          <Route path="/import" element={<Import />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<Campaigns />} />
          <Route path="/search" element={<Creators />} />
          <Route path="/brands" element={<Brands />} />
          <Route path="/hashtags" element={<Hashtags />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
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
      <h1>Lead Management</h1>
      <button
        className="cmdk-trigger"
        onClick={() => window.dispatchEvent(new Event("open-command-k"))}
      >
        Search leads… <kbd>⌘K</kbd>
      </button>
      <nav>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <NavLink to="/search">Search</NavLink>
        <NavLink to="/brands">Brands</NavLink>
        <NavLink to="/lists">Lists</NavLink>
        <NavLink to="/leads">Leads</NavLink>
        <NavLink to="/campaigns">Campaigns</NavLink>
        <NavLink to="/hashtags">Hashtags</NavLink>
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
