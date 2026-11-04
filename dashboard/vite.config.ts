import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/status': 'http://127.0.0.1:8080', '/events': 'http://127.0.0.1:8080' },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
