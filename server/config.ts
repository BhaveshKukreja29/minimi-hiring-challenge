try {
  process.loadEnvFile();
} catch {}

const env = (k: string, fallback = "") => process.env[k] || fallback;

export const GROQ_API_KEY = env("GROQ_API_KEY");
export const EXA_API_KEY = env("EXA_API_KEY");
export const FRONTEND_ORIGINS = env("FRONTEND_ORIGINS", "*").split(",");
export const PORT = Number(env("PORT", "8787"));
export const DB_PATH = env("DB_PATH", "verbatim.db");
export const TURSO_URL = env("TURSO_URL");
export const TURSO_TOKEN = env("TURSO_TOKEN");

export const DEFAULT_MODEL = "qwen/qwen3.8-27b";
export const FALLBACK_MODEL = "openai/gpt-oss-120b";
export const MEMORY_MODEL = "openai/gpt-oss-20b"; // its own rate-limit bucket, off the chat model's

type Params = Record<string, unknown>;
const reasoning = (fast: string, think: string, extra: Params = {}) => ({
  fast: { reasoning_effort: fast, ...extra },
  think: { reasoning_effort: think, ...extra },
});

// Groq free tier chat models, with the extra params for "fast" and "think" mode.
export const MODELS: Record<string, { label: string; fast: Params; think: Params }> = {
  "qwen/qwen3.8-27b": { label: "Qwen 3.8 27B", ...reasoning("none", "default") },
  "openai/gpt-oss-120b": { label: "GPT-OSS 120B", ...reasoning("low", "medium", { include_reasoning: false }) },
  "openai/gpt-oss-20b": { label: "GPT-OSS 20B", ...reasoning("low", "medium", { include_reasoning: false }) },
  "llama-3.3-70b-versatile": { label: "Llama 3.3 70B", fast: {}, think: {} },
  "llama-3.1-8b-instant": { label: "Llama 3.1 8B", fast: {}, think: {} },
  "minimaxai/minimax-m2.7": { label: "MiniMax M2.7", fast: {}, think: {} },
  "meta-models/muse-spark-open": { label: "Muse Spark", ...reasoning("low", "high") },
};

// Groq's free tier caps a request at ~7k input tokens, so every part of the prompt has a budget:
// evidence ~2.5k tokens per round (results are split across parallel queries), memory ~1.5k, history ~1.5k.
export const SEARCH_RESULTS = 6;
export const MAX_QUERIES = 4;
export const HIGHLIGHT_CHARS = 1400;
export const MAX_SEARCH_ROUNDS = 1; // one round of parallel searches; raise to 2 on a paid tier
