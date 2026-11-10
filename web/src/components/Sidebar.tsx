import type { Thread } from "../api";
import { go } from "../nav";

function bucket(ts: number) {
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  return days < 1 ? "Today" : days < 2 ? "Yesterday" : days < 7 ? "This week" : "Earlier";
}

type Props = {
  threads: Thread[];
  current: string;
  onOpen: (id: string | null) => void;
  onDelete: (id: string) => void;
  onLedger: () => void;
};

export function Sidebar({ threads, current, onOpen, onDelete, onLedger }: Props) {
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const b = bucket(t.updated_at);
    groups.set(b, [...(groups.get(b) ?? []), t]);
  }

  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onOpen(null)}>
        Verbatim
      </button>
      <button className="new" onClick={() => onOpen(null)}>
        + new conversation
      </button>
      <nav className="threads">
        {[...groups].map(([name, list]) => (
          <section key={name}>
            <h3 className="meta">{name}</h3>
            {list.map((t) => (
              <div key={t.id} className={`thread ${t.id === current ? "active" : ""}`}>
                <button onClick={() => onOpen(t.id)}>{t.title}</button>
                <button className="x" onClick={() => onDelete(t.id)} title="Delete conversation" aria-label="Delete conversation">
                  ×
                </button>
              </div>
            ))}
          </section>
        ))}
        {threads.length === 0 && <p className="meta muted">Your conversations land here.</p>}
      </nav>
      <footer>
        <button className="meta link" onClick={onLedger}>
          the ledger
        </button>
        <a className="meta link" href="/faq" onClick={go("/faq")}>
          faq
        </a>
      </footer>
    </aside>
  );
}
