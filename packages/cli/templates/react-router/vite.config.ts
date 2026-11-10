import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [reactRouter()],
  server: {
    // The port in storeware.app.toml, which `storeware app dev` tunnels to.
    port: 4000,
    strictPort: true,
    // The tunnel's address changes every run, and Vite refuses a host it does
    // not know. Development only: `react-router-serve` has no such check.
    allowedHosts: true,
  },
});
