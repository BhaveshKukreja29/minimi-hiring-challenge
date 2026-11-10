import { useEffect, useState, type MouseEvent } from "react";

export function navigate(path: string) {
  history.pushState({ inApp: true }, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** For <a> tags: same-tab navigation without a page load, so a streaming answer keeps going. */
export const go = (path: string) => (e: MouseEvent) => {
  e.preventDefault();
  navigate(path);
};

/** Back to wherever you came from in the app, or home if you landed here directly. */
export const back = (e: MouseEvent) => {
  e.preventDefault();
  if (history.state?.inApp) history.back();
  else navigate("/");
};

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}
