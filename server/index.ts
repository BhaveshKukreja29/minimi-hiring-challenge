import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { APIError } from "groq-sdk";
import { run } from "./agent.ts";
import { DEFAULT_MODEL, FRONTEND_ORIGINS, MODELS, PORT } from "./config.ts";
import * as memory from "./memory.ts";

const ID = /^[A-Za-z0-9-]{8,64}$/;

function userOf(c: Context) {
  const id = c.req.header("x-user-id") ?? "";
  if (!ID.test(id)) throw new HTTPException(400, { message: "bad user id" });
  return id;
}

function validTz(tz: unknown) {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: String(tz) }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

const app = new Hono();
app.use(cors({ origin: FRONTEND_ORIGINS.includes("*") ? "*" : FRONTEND_ORIGINS }));

app.get("/health", (c) => c.json({ ok: true }));
app.get("/models", (c) =>
  c.json({ default: DEFAULT_MODEL, models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) }),
);
app.get("/threads", async (c) => c.json(await memory.threads(userOf(c))));
app.get("/threads/:id", async (c) => c.json(await memory.threadMessages(userOf(c), c.req.param("id"))));
app.delete("/threads/:id", async (c) => {
  await memory.deleteThread(userOf(c), c.req.param("id"));
  return c.json({ ok: true });
});
app.get("/memory", async (c) => c.json(await memory.facts(userOf(c))));
app.delete("/memory/:id", async (c) => {
  await memory.deleteFact(userOf(c), Number(c.req.param("id")));
  return c.json({ ok: true });
});
app.delete("/messages/:id", async (c) => {
  await memory.deleteExchange(userOf(c), Number(c.req.param("id")));
  return c.json({ ok: true });
});

app.post("/chat", async (c) => {
  const user = userOf(c);
  const body = await c.req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!ID.test(body.thread_id ?? "") || !message || message.length > 4000) throw new HTTPException(400, { message: "bad request" });
  const model = MODELS[body.model] ? body.model : DEFAULT_MODEL;

  // The answer keeps generating and gets saved even if the browser leaves mid-stream.
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (e: object) => open && ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      (async () => {
        try {
          for await (const e of run(user, body.thread_id, message, model, !!body.think, validTz(body.tz))) send(e);
        } catch (e) {
          console.error("chat failed:", e instanceof APIError ? e.message : e);
          const limited = e instanceof APIError && (e.status === 429 || e.status === 413);
          send({
            type: "error",
            text: limited
              ? "Groq's free tier is out of tokens for this minute. Give it a few seconds and ask again."
              : "Something broke on our side. Try again in a bit.",
          });
        }
        if (open) ctrl.close();
      })();
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
});

await memory.init();
serve({ fetch: app.fetch, port: PORT }, () => console.log(`api on http://localhost:${PORT}`));

// Render sends SIGTERM before it sleeps or redeploys: push pending writes to Turso first.
process.on("SIGTERM", () => memory.flush().finally(() => process.exit(0)));
