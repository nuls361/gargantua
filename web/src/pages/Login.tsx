import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
    // On success the onAuthStateChange listener in App re-renders into the app.
  }

  async function forgot() {
    if (!email) {
      setError("Trag zuerst deine Email ein, dann „Passwort vergessen“.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setBusy(false);
    if (error) setError(error.message);
    else setNotice(`Link zum Passwort-Setzen an ${email} geschickt. Auch für die erste Anmeldung nach einer Einladung.`);
  }

  return (
    <div className="login-wrap">
      <div className="panel">
        <h2>Anmelden</h2>
        {error && <div className="error">{error}</div>}
        {notice && <div className="success">{notice}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              style={{ width: "100%" }}
            />
          </div>
          <div className="field">
            <label>Passwort</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: "100%" }}
            />
          </div>
          <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "…" : "Anmelden"}
          </button>
        </form>
        <button
          onClick={forgot}
          disabled={busy}
          style={{ marginTop: 12, width: "100%", background: "none", border: "none", boxShadow: "none", color: "var(--muted)", fontWeight: 500 }}
        >
          Passwort vergessen / Einladung annehmen
        </button>
      </div>
    </div>
  );
}
