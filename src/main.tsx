import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

// No StrictMode: its double-mount in dev would spawn every claude session twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
