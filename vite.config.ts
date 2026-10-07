import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend port is configurable so the app can run alongside other services
// (e.g. a Laravel/php dev server that already occupies 8000).
// Precedence must MATCH scripts/start-backend.js exactly (PORT → BACKEND_PORT),
// otherwise the proxy would point at a different port than the server listens on.
const BACKEND_PORT = process.env.PORT || process.env.BACKEND_PORT || '8000'
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // Never serve secrets from the dev server root (cookies hold live YouTube sessions)
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', 'cookies.txt', '**/cookies.txt', '**/*cookies*.txt'],
    },
    watch: {
      ignored: ['**/dist_app/**', '**/dist_installer/**', '**/build/**', '**/venv/**']
    },
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res: any) => {
            if (res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: `Backend API server on port ${BACKEND_PORT} is not running. Start the backend with \`./run.sh\` or \`python -m uvicorn backend.main:app --port ${BACKEND_PORT}\`.`,
                status: 503
              }));
            }
          });
        }
      },
      '/docs': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
      '/redoc': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
      '/openapi.json': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    }
  }
})

