import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '',
  define: {
    '__APP_VERSION__': JSON.stringify(pkg.version),
  },
  server: {
    port: 3000,
    host: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
