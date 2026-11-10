import { useEffect, useState } from "react";
import { forgetFact, get, type Fact } from "../api";

const day = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Ledger({ onClose }: { onClose: () => void }) {
  const [facts, setFacts] = useState<Fact[] | null>(null);

  useEffect(() => {
    get<Fact[]>("/memory").then(setFacts);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);

  const forget = (id: number) => {
    forgetFact(id);
    setFacts((f) => f!.filter((x) => x.id !== id));
  };

  const active = facts?.filter((f) => !f.valid_to) ?? [];
  const past = facts?.filter((f) => f.valid_to).reverse() ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="ledger" onClick={(e) => e.stopPropagation()} aria-label="Memory">
        <header>
          <h2>The Ledger</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="meta muted">
          What I remember about you, and since when. When something changes, the old entry is struck out, not erased.
        </p>
        {facts === null && <p className="meta">opening the books…</p>}
        {facts?.length === 0 && <p className="muted">Nothing yet. Tell me something about yourself.</p>}
        <ul>
          {active.map((f) => (
            <li key={f.id}>
              <span>
                {f.subject !== "user" && `${f.subject} · `}<b>{f.predicate}</b> {f.object}
              </span>
              <span className="meta">since {day(f.valid_from)}</span>
              <button className="forget" onClick={() => forget(f.id)} aria-label="Forget">
                forget
              </button>
            </li>
          ))}
        </ul>
        {past.length > 0 && (
          <>
            <h3 className="meta">no longer true</h3>
            <ul className="past">
              {past.map((f) => (
                <li key={f.id}>
                  <s>
                    {f.subject !== "user" && `${f.subject} · `}<b>{f.predicate}</b> {f.object}
                  </s>
                  <span className="meta">
                    {day(f.valid_from)} → {day(f.valid_to!)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
