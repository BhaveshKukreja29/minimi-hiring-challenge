export const API = (import.meta.env.VITE_API_URL || "http://localhost:8787").replace(/\/+$/, "");

export type Source = { n: number; title: string; url: string; domain: string; published: string };
export type Sentence = { text: string; source: number };
export type Evidence = { sources: Source[]; sentences: Record<string, Sentence> };
export type Timings = { first_token_ms: number; search_ms: number; total_ms: number };
export type Message = {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  evidence?: Evidence | null;
  timings?: Timings;
  model?: string;
};
export type Thread = { id: string; title: string; updated_at: number };
export type Fact = {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  valid_from: number;
  valid_to: number | null;
};
export type Model = { id: string; label: string };

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "search"; queries: string[] }
  | { type: "sources"; sources: Source[]; sentences: Record<string, Sentence> }
  | { type: "notice"; text: string }
  | { type: "error"; text: string }
  | { type: "reset" }
  | {
      type: "done";
      id: number;
      user_message_id: number;
      content: string;
      evidence: Evidence | null;
      model: string;
      timings: Timings;
    };

export const newId = () => crypto.randomUUID();

function userId() {
  let id = localStorage.getItem("verbatim-user");
  if (!id) localStorage.setItem("verbatim-user", (id = newId()));
  return id;
}

const headers = () => ({ "X-User-Id": userId(), "Content-Type": "application/json" });

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(API + path, { headers: headers() });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export const forgetFact = (id: number) => fetch(`${API}/memory/${id}`, { method: "DELETE", headers: headers() });
export const deleteThread = (id: string) => fetch(`${API}/threads/${id}`, { method: "DELETE", headers: headers() });
export const deleteExchange = (id: number) => fetch(`${API}/messages/${id}`, { method: "DELETE", headers: headers() });

export async function chat(
  body: { thread_id: string; message: string; model: string; think: boolean },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = await fetch(API + "/chat", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...body, tz }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`${r.status}`);

  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    const events = buf.split("\n\n");
    buf = events.pop()!;
    for (const e of events) if (e.startsWith("data: ")) onEvent(JSON.parse(e.slice(6)));
  }
}
