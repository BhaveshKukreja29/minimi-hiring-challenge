import { useEffect, useState } from "react";
import { go } from "../nav";

const LINES = [
  "Waking the server up. It was having a lovely nap.",
  "Pouring coffee into the backend.",
  "Ironing today's edition.",
  "Asking the hamster to run a bit faster.",
  "Setting the type, one letter at a time.",
  "Bribing Render with compliments.",
  "Still faster than the actual newspaper boy.",
];

export function Wakeup() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // A fast backend answers before this shows, so there's no flash on warm loads.
  if (secs < 1) return null;

  return (
    <main className="wakeup">
      <h1 className="masthead">Verbatim</h1>
      <div className="press" aria-hidden />
      <p className="wakeup-lead">
        We're on the free tier of Render, have some patience till the backend loads :)
      </p>
      <p className="wakeup-line" key={Math.floor(secs / 4)}>
        {LINES[Math.floor(secs / 4) % LINES.length]}
      </p>
      <p className="meta">
        {String(Math.floor(secs / 60)).padStart(2, "0")}:{String(secs % 60).padStart(2, "0")} · usually under a minute
      </p>
      <a className="meta link" href="/faq" onClick={go("/faq")}>
        read the FAQ while you wait →
      </a>
    </main>
  );
}
