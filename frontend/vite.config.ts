import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-time proxy to the existing Express backend (run separately with
      // `npm run dev` in the Dashboard folder). Point VITE_API_TARGET at a
      // throwaway instance to try things out without touching real data.
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
})
