import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Browser e2e points this at the test orchestrator (ORCH_PROXY_TARGET). The default
// stays the live dev orchestrator so `pnpm dev` is unchanged.
const orchTarget = process.env.ORCH_PROXY_TARGET || "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["unimpeded-fraying-imprudent.ngrok-free.dev"],
    proxy: {
      "/v1": { target: "http://127.0.0.1:3000", ws: true, changeOrigin: true },
      "/places": { target: orchTarget, changeOrigin: true },
      "/dev": { target: orchTarget, changeOrigin: true },
    },
  },
  preview: { host: true, port: 4173 },
});
