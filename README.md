# Verbatim

A chat agent with one tool, web search, that answers with receipts. Every quote is word for word from the source, and clicking one opens the page highlighted at that sentence. It also remembers what you asked and when, so "what did I ask you on 3 November, is it still correct?" just works.

How it works and why: [DESIGN.md](DESIGN.md).

Try it live: https://minimi-hiring-challenge.vercel.app/

**Note**: The above link will take about 25 seconds until render starts the sever!

## Run it

Needs Node 20.12+.

```
cp .env.example .env     # add GROQ_API_KEY and EXA_API_KEY, both have free tiers
npm install
npm run dev              # web on http://localhost:5173, api on :8787
```

`npm run eval` runs the real agent against a QA set and the memory scripts and prints a report.

```
server/   Hono API · agent loop · Exa search · recall · SQLite/Turso memory
web/      React + Vite, no UI or markdown libraries
shared/   citation parsing used by both
eval/     end to end eval
```

PS: I forgot initializing git in hurry (and exam stress) so there's only 1 code commit :P

Trust me I make atomic commits otherwise!!
