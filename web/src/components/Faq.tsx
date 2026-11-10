import { back } from "../nav";

const QA: [string, string][] = [
  [
    "What is this?",
    "A chat agent with exactly one tool: web search. It answers fast, quotes its sources word for word, and remembers what you told it and when you said it.",
  ],
  [
    "Lots of chatbots cite sources. What's different?",
    "Most of them put a little [1] next to a sentence they wrote themselves. You have to trust that the page actually says that. Here, the quote is the page. Click it and the source opens scrolled to that exact sentence, highlighted (on most sites; some sites' scripts reset the scroll after they load).",
  ],
  [
    "How do you know the quotes are real?",
    "The model never types a quote. Every sentence from search gets an id like s12, and the model can only point at ids. The app then swaps the id for the original sentence. If the model makes up an id, nothing shows up. So a fake quote can't happen, by design, not by hoping the model behaves.",
  ],
  [
    "Doesn't that just mean it can quote something irrelevant?",
    "It can pick the wrong sentence, sure. But you see that immediately, because the sentence is right there under the claim. A misquote is visible. A hallucinated paraphrase isn't. That's the trade I wanted.",
  ],
  [
    "How does memory work?",
    "Every message is stored with a timestamp. When you say \"last Tuesday\" or \"on 3 November\", the server works out the exact date and pulls everything from that day: your question, its answer, and the quotes with their publish dates. Mention a topic you talked about before and it finds that too. So \"is your answer still correct?\" means re-searching and comparing against what it actually said, not a guess. On top of that, a second model keeps facts about you as small triples (you, live in, Pune) with a start date. When one changes, the old fact gets an end date instead of being deleted.",
  ],
  [
    "Can I see what it remembers?",
    "Yes. Open the Ledger from the sidebar. Current facts, old facts struck out with their dates, and a forget button on each one. You can also delete any question from a chat, which deletes its answer and whatever was learned from it.",
  ],
  [
    "Why is it fast?",
    "Groq runs Qwen 3.8 27B at around 450 tokens a second. Search returns the relevant passages in the same call, so there's no second round of page fetching. Quotes are ids, so the model writes fewer tokens. Memory extraction runs in parallel on a different model, so it adds zero wait. Every answer shows its own timings, so you don't have to take my word for it.",
  ],
  [
    "Which models can I use?",
    "Any chat model on Groq's free tier: Qwen, GPT-OSS, Llama, MiniMax, Muse. Qwen is the default. Flip the think toggle if you want it to reason first. Slower, sharper.",
  ],
  [
    "Why did it take a minute to load?",
    "The backend lives on Render's free tier, which naps after 15 minutes of nobody talking to it. Waking up takes around 30 to 50 seconds. After that it's quick, promise :)",
  ],
  [
    "Is my data private?",
    "There are no accounts. Your browser gets a random id, and your chats and memory are tied to it. Clear your browser storage and you're a stranger again.",
  ],
];

export function Faq() {
  return (
    <main className="faq">
      <header className="topbar">
        <a className="meta link" href="/" onClick={back}>
          ← back to chat
        </a>
        <span className="meta">FREQUENTLY ASKED</span>
      </header>
      <div className="column">
        <h1 className="masthead">Verbatim</h1>
        <p className="tagline">Questions people ask, answered without a single made up quote.</p>
        <div className="rule-double" />
        {QA.map(([q, a], i) => (
          <section key={q} className="faq-item">
            <span className="meta">No. {i + 1}</span>
            <h2>{q}</h2>
            <p>{a}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
