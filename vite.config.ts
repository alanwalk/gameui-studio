import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Magpie is the only model source. The browser cannot reach it directly (the gateway
// has no CORS headers, and `magpie mcp image` is a stdio process), so both go through
// the middleware in server/apiPlugin.ts. Credentials stay on the server.
export default defineConfig(async ({ mode }) => {
  const serverEnv = loadEnv(mode, process.cwd(), ['MAGPIE_', 'GAMEUI_']);
  for (const [name, value] of Object.entries(serverEnv)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  // Load server modules after their environment is ready.
  const { magpieApi } = await import('./server/apiPlugin');
  return {
    plugins: [react(), magpieApi()],
    server: {
      port: 5173,
      // Runtime data and Python environments are not frontend source files.
      watch: { ignored: ['**/.data/**', '**/.venv-seg/**'] },
    },
  };
});
