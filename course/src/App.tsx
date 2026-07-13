import { useEffect, useState, useSyncExternalStore } from "react";
import { MODULES } from "./modules";
import { getProgress, isModuleDone, recordVisit, subscribe } from "./progress";

function useHashRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ""));
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace(/^#\/?/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [route, (r: string) => (window.location.hash = r ? `#/${r}` : "#")];
}

export function App() {
  const [route, navigate] = useHashRoute();
  useSyncExternalStore(subscribe, getProgress);

  const activeIdx = MODULES.findIndex((m) => m.id === route);
  const active = activeIdx >= 0 ? MODULES[activeIdx] : undefined;

  useEffect(() => {
    if (active) recordVisit(active.id);
    window.scrollTo(0, 0);
  }, [route, active]);

  const doneCount = MODULES.filter((m) => isModuleDone(m.id)).length;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => navigate("")}>
          <div className="brand-logo" />
          <div>
            <h1>loop-generator</h1>
            <p>The Feedback Loop Workshop</p>
          </div>
        </div>
        <a className="docs-link" href="../">
          ← Docs &amp; trust model
        </a>
        <div className="progress-summary">
          {doneCount} of {MODULES.length} modules complete
          <div className="progress-bar">
            <div style={{ width: `${(doneCount / MODULES.length) * 100}%` }} />
          </div>
        </div>
        {MODULES.map((m, i) => {
          const done = isModuleDone(m.id);
          return (
            <button
              key={m.id}
              className={`nav-module ${m.id === route ? "active" : ""} ${done ? "done" : ""}`}
              onClick={() => navigate(m.id)}
            >
              <span className="nav-num">{done ? "✓" : i + 1}</span>
              <span className="nav-title">
                {m.title}
                <span className="nav-sub">{m.subtitle}</span>
              </span>
            </button>
          );
        })}
      </aside>
      <main className="main">
        {active ? (
          <>
            <div className="module-header">
              <div className="module-kicker">
                Module {activeIdx + 1} of {MODULES.length}
              </div>
              <h1>{active.title}</h1>
              <p className="lede">{active.lede}</p>
              {active.docs && (
                <p style={{ fontSize: 13.5, color: "var(--ink-faint)", margin: "8px 0 0" }}>
                  Reference doc: <a href={active.docs.href}>{active.docs.label}</a>
                </p>
              )}
            </div>
            <active.Component />
            <div className="footer-nav">
              {activeIdx > 0 ? (
                <button className="btn ghost" onClick={() => navigate(MODULES[activeIdx - 1]!.id)}>
                  ← {MODULES[activeIdx - 1]!.title}
                </button>
              ) : (
                <button className="btn ghost" onClick={() => navigate("")}>
                  ← Course home
                </button>
              )}
              {activeIdx < MODULES.length - 1 && (
                <button className="btn" onClick={() => navigate(MODULES[activeIdx + 1]!.id)}>
                  {MODULES[activeIdx + 1]!.title} →
                </button>
              )}
            </div>
          </>
        ) : (
          <Home onOpen={navigate} />
        )}
      </main>
    </div>
  );
}

function Home(props: { onOpen: (id: string) => void }) {
  return (
    <div>
      <div className="home-hero">
        <div className="module-kicker">An interactive workshop</div>
        <h1>Master the Feedback Loop</h1>
        <p className="lede">
          Learn exactly how <code>loop-generator</code> turns a <code>.loop.yaml</code> spec into a
          self-correcting agent coding loop — the mechanics, the trust model, how the LLM is prompted,
          and how to design evaluators that can't be fooled.
        </p>
      </div>
      <div className="module-grid">
        {MODULES.map((m, i) => (
          <button key={m.id} className="module-card" onClick={() => props.onOpen(m.id)}>
            <span className="nav-num" style={{ display: "inline-flex" }}>
              {isModuleDone(m.id) ? "✓" : i + 1}
            </span>
            <h3>{m.title}</h3>
            <p>{m.subtitle}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
