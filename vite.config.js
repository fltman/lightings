import { defineConfig } from 'vite'

// Frontend dev server. The browser talks to the relay backend over a WebSocket
// at /live; in dev we proxy that to the Node relay on :8088. In production the
// same Node process serves the built assets and the /live socket on one origin.
export default defineConfig({
  server: {
    port: 5188,
    strictPort: true,
    proxy: {
      '/live': {
        target: 'ws://localhost:8088',
        ws: true,
        changeOrigin: true,
      },
      // Backend HTTP routes the frontend fetches (radar frames, CAPE grid, health).
      '/radar': { target: 'http://localhost:8088', changeOrigin: true },
      '/aurora': { target: 'http://localhost:8088', changeOrigin: true },
      '/ask': { target: 'http://localhost:8088', changeOrigin: true },
      '/health': { target: 'http://localhost:8088', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
