import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, Plugin} from 'vite';


export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['@techstark/opencv-js', 'onnxruntime-web'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '127.0.0.1',
    hmr: {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 3000,
      timeout: 30000,
    },
    watch: {
      usePolling: true,
      ignored: [
        '**/src-tauri/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/Selfevolving/**',
        '**/self learning/**',
        '**/*.log',
        '**/*.txt'
      ],
    },
  },
});
