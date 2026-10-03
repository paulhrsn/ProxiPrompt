import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SpacetimeProvider } from "./spacetime";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SpacetimeProvider>
      <App />
    </SpacetimeProvider>
  </StrictMode>,
);
