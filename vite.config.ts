import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const projectRoot = path.resolve(__dirname);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  root: projectRoot,

  // Use RELATIVE asset paths in the built index.html (./assets/... instead of /assets/...).
  // This makes the production bundle bulletproof under Tauri's custom protocol
  // (http://tauri.localhost on Windows) and avoids any "localhost refused to connect"
  // / blank-screen issues caused by absolute-path asset resolution.
  base: "./",

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.join(projectRoot, "src"),
    },
  },
}));
