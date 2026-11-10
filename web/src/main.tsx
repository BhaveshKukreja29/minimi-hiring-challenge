import { createRoot } from "react-dom/client";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
