import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "^/api/(?![^?]+\\.ts(?:\\?|$))": { target: `http://127.0.0.1:${process.env.PORT ?? 8787}`, changeOrigin: true },
    },
  },
});
