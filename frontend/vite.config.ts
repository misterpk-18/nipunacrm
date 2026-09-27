import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The Flask API runs on :5050 (macOS AirPlay holds :5000) (APP_ENV=development → nipunacrm-dev). Proxying /api keeps the
// frontend and API on one origin, so no CORS is needed in dev or behind the production reverse proxy.
const API_TARGET = process.env["VITE_API_TARGET"] ?? "http://127.0.0.1:5050";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss(), tsconfigPaths()],
  server: { port: 5173, proxy: { "/api": { target: API_TARGET, changeOrigin: true } } },
  preview: { port: 4173, proxy: { "/api": { target: API_TARGET, changeOrigin: true } } },
});
