import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Keep the browser's Host header: the API's CSRF check compares Origin to the
// request origin, and Vite's string shorthand would rewrite Host to :8787.
const api = { target: 'http://127.0.0.1:8787', changeOrigin: false };
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/v1': api,
      '/auth': api,
      '/account': api,
      '/health': api,
    },
  },
});
