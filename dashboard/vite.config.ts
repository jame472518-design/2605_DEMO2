import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "/static/" so production assets resolve under the sensor-bridge
// plugin's /static/* prefix route. host: true makes vite dev server bind on
// 0.0.0.0 so a phone on the same LAN can reach `pnpm run dev`.
export default defineConfig({
  base: "/static/",
  plugins: [react()],
  server: { host: true, port: 5173 },
});
