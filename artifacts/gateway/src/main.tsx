import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.innerHTML =
    '<div style="padding:2rem;font-family:system-ui;color:#dc2626">Fatal: #root element not found in HTML</div>';
} else {
  createRoot(rootEl).render(<App />);
}
