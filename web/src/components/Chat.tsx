import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chat, deleteExchange, deleteThread, get, newId, type Evidence, type Message, type Model, type Thread } from "../api";
import { Answer } from "./Answer";
import { Ledger } from "./Ledger";
import { Sidebar } from "./Sidebar";

type Draft = { text: string; evidence: Evidence | null; queries: string[]; notice: string; error: string };

const SUGGESTIONS = [
  "What happened in tech news this week?",
  "Is it true that octopuses have three hearts?",
  "Remember that I'm vegetarian and live in Pune.",
];

const time = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

const dateline = new Date()
  .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  .toUpperCase();

const threadFromUrl = () => new URLSearchParams(location.search).get("t");

export function Chat() {
  const [threadId, setThreadId] = useState(() => threadFromUrl() ?? newId());
  const [messages, setMessages] = useState<Message[] | null>(() => (threadFromUrl() ? null : [])); // null while loading
  const [threads, setThreads] = useState<Thread[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem("verbatim-model") ?? "");
  const [think, setThink] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ledger, setLedger] = useState(false);
  const [menu, setMenu] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const current = useRef(threadId);
  const streaming = useRef(false);

  const refreshThreads = useCallback(() => get<Thread[]>("/threads").then(setThreads).catch(() => {}), []);

  useEffect(() => {
    refreshThreads();
    get<{ default: string; models: Model[] }>("/models").then((r) => {
      setModels(r.models);
      setModel((m) => (r.models.some((x) => x.id === m) ? m : r.default));
    });
  }, [refreshThreads]);

  // If you left mid-answer, the server kept going. Check back until the answer lands.
  const load = useCallback((id: string, tries = 0) => {
    get<Message[]>(`/threads/${id}`)
      .then((m) => {
        if (current.current !== id || streaming.current) return;
        setMessages(m);
        const last = m.at(-1);
        if (last?.role === "user" && Date.now() / 1000 - last.created_at < 120 && tries < 40)
          setTimeout(() => load(id, tries + 1), 1500);
      })
      .catch(() => current.current === id && setMessages([]));
  }, []);

  useEffect(() => {
    const t = threadFromUrl();
    if (t) load(t);
  }, [load]);

  const openThread = (id: string | null) => {
    abort.current?.abort();
    streaming.current = false;
    const next = id ?? newId();
    history.replaceState(null, "", id ? `/?t=${id}` : "/");
    current.current = next;
    setThreadId(next);
    setDraft(null);
    setMenu(false);
    setMessages(id ? null : []);
    pinned.current = true;
    if (id) load(id);
  };

  const remove = useCallback((id: Message["id"]) => {
    if (typeof id !== "number") return;
    setMessages((m) => {
      const i = m?.findIndex((x) => x.id === id) ?? -1;
      if (!m || i < 0) return m;
      return m.filter((_, j) => j !== i && !(j === i + 1 && m[j].role === "assistant"));
    });
    deleteExchange(id).then(refreshThreads);
  }, [refreshThreads]);

  const removeThread = (id: string) => {
    if (!confirm("Delete this conversation and everything learned from it?")) return;
    setThreads((t) => t.filter((x) => x.id !== id));
    if (id === threadId) openThread(null);
    deleteThread(id).then(refreshThreads);
  };

  const empty = messages?.length === 0 && !draft;

  // Stick to the bottom while streaming, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current && !empty) el.scrollTop = el.scrollHeight;
  }, [messages, draft, empty]);

  const send = async (text: string) => {
    if (!text.trim() || (draft && !draft.error)) return;
    const ctrl = (abort.current = new AbortController());
    const now = Date.now() / 1000;
    const tempId = `u${now}`;
    streaming.current = true;
    setMessages((m) => [...(m ?? []), { id: tempId, role: "user", content: text, created_at: now }]);
    history.replaceState(null, "", `/?t=${threadId}`);
    pinned.current = true;

    // Tokens arrive faster than the screen refreshes; batch them into one render per frame.
    let d: Draft = { text: "", evidence: null, queries: [], notice: "", error: "" };
    let frame = 0;
    const flush = () => {
      frame = 0;
      setDraft({ ...d });
    };
    const schedule = () => (frame ||= requestAnimationFrame(flush));
    setDraft(d);

    try {
      await chat({ thread_id: threadId, message: text, model, think }, (e) => {
        if (e.type === "token") d.text += e.text;
        else if (e.type === "search") d = { ...d, text: "", queries: [...d.queries, ...e.queries] };
        else if (e.type === "reset") d = { ...d, text: "" };
        else if (e.type === "sources") d = { ...d, evidence: { sources: e.sources, sentences: e.sentences } };
        else if (e.type === "notice") d = { ...d, notice: e.text };
        else if (e.type === "error") d = { ...d, error: e.text };
        else if (e.type === "done") {
          cancelAnimationFrame(frame);
          frame = -1;
          const done: Message = {
            id: e.id,
            role: "assistant",
            content: e.content,
            created_at: Date.now() / 1000,
            evidence: e.evidence,
            timings: e.timings,
            model: e.model,
          };
          setMessages((m) => [...(m ?? []).map((x) => (x.id === tempId ? { ...x, id: e.user_message_id } : x)), done]);
          setDraft(null);
          refreshThreads();
          return;
        }
        schedule();
      }, ctrl.signal);
    } catch {
      if (!ctrl.signal.aborted) d = { ...d, error: "Couldn't reach the server. Try again?" };
    }
    if (abort.current === ctrl) streaming.current = false;
    if (frame !== -1) {
      cancelAnimationFrame(frame);
      setDraft(d.error && !ctrl.signal.aborted ? { ...d } : null);
    }
  };

  const label = (id?: string) => models.find((m) => m.id === id)?.label ?? id;

  return (
    <div className={`shell ${menu ? "menu-open" : ""}`}>
      <Sidebar
        threads={threads}
        current={threadId}
        onOpen={openThread}
        onDelete={removeThread}
        onLedger={() => setLedger(true)}
      />
      <main className="page">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setMenu(!menu)} aria-label="Menu">
            ☰
          </button>
          <span className="meta">{dateline}</span>
          <span className="meta hide-mobile">ANSWERS WITH RECEIPTS</span>
        </header>

        <div
          className="scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className={`column ${empty ? "centered" : ""}`}>
            {empty && <Empty onPick={send} />}
            {messages?.map((m) => (
              <Item key={m.id} m={m} label={label(m.model)} onDelete={remove} />
            ))}
            {draft && <Live d={draft} />}
          </div>
        </div>

        <Composer
          busy={!!draft && !draft.error}
          onSend={send}
          onStop={() => abort.current?.abort()}
          models={models}
          model={model}
          setModel={(m) => {
            setModel(m);
            localStorage.setItem("verbatim-model", m);
          }}
          think={think}
          setThink={setThink}
        />
      </main>
      {ledger && <Ledger onClose={() => setLedger(false)} />}
    </div>
  );
}

function Empty({ onPick }: { onPick: (s: string) => void }) {
  return (
    <section className="empty">
      <h1 className="masthead">Verbatim</h1>
      <p className="tagline">A search agent that shows its receipts. Every quote is word for word from the source.</p>
      <div className="rule-double" />
      <ul className="suggestions">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <button onClick={() => onPick(s)}>{s}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type ItemProps = { m: Message; label?: string; onDelete: (id: Message["id"]) => void };

const Item = memo(function Item({ m, label, onDelete }: ItemProps) {
  if (m.role === "user")
    return (
      <article className="q">
        <div className="q-meta">
          <time className="meta">{time(m.created_at)}</time>
          {typeof m.id === "number" && (
            <button className="meta link delete" onClick={() => onDelete(m.id)} title="Delete this question and its answer">
              delete
            </button>
          )}
        </div>
        <h2>{m.content}</h2>
      </article>
    );
  return (
    <article className="a">
      <Answer text={m.content} evidence={m.evidence} />
      <Footer evidence={m.evidence} />
      {m.timings && (
        <p className="meta timings">
          first word {fmtMs(m.timings.first_token_ms)}
          {m.timings.search_ms > 0 && ` · search ${fmtMs(m.timings.search_ms)}`} · total {fmtMs(m.timings.total_ms)}
          {label && ` · ${label}`}
        </p>
      )}
    </article>
  );
});

function Live({ d }: { d: Draft }) {
  return (
    <article className="a live">
      {d.queries.length > 0 && (
        <p className="meta searching">
          {d.evidence ? "searched" : "searching"} {d.queries.map((q) => `“${q}”`).join(", ")}
        </p>
      )}
      {d.text ? <Answer text={d.text} evidence={d.evidence} /> : !d.queries.length && !d.error && <p className="meta">thinking…</p>}
      {d.text && !d.error && <span className="caret" aria-hidden />}
      {d.notice && <p className="meta notice">{d.notice}</p>}
      {d.error && <p className="meta notice">{d.error}</p>}
    </article>
  );
}

function Footer({ evidence }: { evidence?: Evidence | null }) {
  if (!evidence?.sources.length) return null;
  const quoted = Object.keys(evidence.sentences).length;
  return (
    <details className="sources">
      <summary className="meta">
        read {evidence.sources.length} sources · {quoted} verbatim {quoted === 1 ? "quote" : "quotes"}
      </summary>
      <ol>
        {evidence.sources.map((s) => (
          <li key={s.n}>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title}
            </a>
            <span className="meta"> {s.domain}{s.published && ` · ${s.published}`}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

type ComposerProps = {
  busy: boolean;
  onSend: (s: string) => void;
  onStop: () => void;
  models: Model[];
  model: string;
  setModel: (m: string) => void;
  think: boolean;
  setThink: (t: boolean) => void;
};

function Composer({ busy, onSend, onStop, models, model, setModel, think, setThink }: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (busy || !text.trim()) return;
    onSend(text.trim());
    setText("");
  };

  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        autoFocus
        placeholder="Ask anything. I'll bring receipts."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-row">
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <label className="toggle" title="Let the model reason before answering. Slower, sharper.">
          <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} />
          <span>think</span>
        </label>
        <span className="spacer" />
        {busy ? (
          <button type="button" className="send" onClick={onStop}>
            stop ■
          </button>
        ) : (
          <button className="send" disabled={!text.trim()}>
            ask ↵
          </button>
        )}
      </div>
    </form>
  );
}
