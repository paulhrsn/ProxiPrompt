import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["unimpeded-fraying-imprudent.ngrok-free.dev"],
    proxy: {
      "/v1": { target: "http://127.0.0.1:3000", ws: true, changeOrigin: true },
      "/places": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/dev": { target: "http://127.0.0.1:8080", changeOrigin: true },
    },
  },
  preview: { host: true, port: 4173 },
});
