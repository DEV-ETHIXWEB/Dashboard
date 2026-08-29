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
  build: {
    rollupOptions: {
      output: {
        // Split the large, rarely-changing vendor libraries into their own
        // cacheable chunks instead of one bundle that has to be re-downloaded
        // in full whenever any app code changes.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react'
          }
          if (/[\\/]node_modules[\\/](recharts|d3-.*|victory-.*)[\\/]/.test(id)) return 'vendor-charts'
          if (/[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'vendor-motion'
          if (/[\\/]node_modules[\\/](@firebase|firebase)[\\/]/.test(id)) return 'vendor-firebase'
          return undefined
        },
      },
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
