import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const root = document.getElementById("root")!;

// Surface any startup/runtime error on screen instead of a blank white page.
function showError(label: string, e: unknown) {
  const msg = e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e);
  root.innerHTML =
    `<pre style="padding:24px;white-space:pre-wrap;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b83636;max-width:900px;margin:40px auto">` +
    `${label}\n\n${msg.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)}</pre>`;
}

window.addEventListener("error", (ev) => showError("Runtime error:", ev.error ?? ev.message));
window.addEventListener("unhandledrejection", (ev) => showError("Promise error:", ev.reason));

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    showError("Render error:", error);
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (e) {
  showError("Startup error:", e);
}
