import { useEffect, useState } from "react";
import { API } from "./api";
import { Chat } from "./components/Chat";
import { Faq } from "./components/Faq";
import { Wakeup } from "./components/Wakeup";
import { usePath } from "./nav";

// Render's free tier sleeps after 15 idle minutes, so poll until it answers.
function useBackend() {
  const [up, setUp] = useState(false);
  useEffect(() => {
    let stop = false;
    const ping = async () => {
      while (!stop) {
        try {
          if ((await fetch(API + "/health", { signal: AbortSignal.timeout(4000) })).ok) return setUp(true);
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    ping();
    return () => void (stop = true);
  }, []);
  return up;
}

export function App() {
  const path = usePath();
  const up = useBackend();
  // The FAQ sits on top of the chat instead of replacing it, so an answer in progress keeps streaming.
  const faq = path === "/faq";
  return (
    <>
      {up ? (
        <div inert={faq}>
          <Chat />
        </div>
      ) : (
        !faq && <Wakeup />
      )}
      {faq && <Faq />}
    </>
  );
}
