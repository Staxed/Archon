import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Vite dev server config — in production, Tauri loads the built files directly
  server: {
    port: 1420,
    strictPort: true,
  },
  // Tauri expects a fixed port; fail if unavailable
  clearScreen: false,
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Tauri uses Chromium on Windows (WebView2) and WebKit on macOS
    target: ['es2022', 'chrome100', 'safari15'],
  },
});
