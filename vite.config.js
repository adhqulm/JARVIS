import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The bundled build of onnxruntime-web has its JavaScript glue inside, so only the .wasm file is fetched at runtime
    // (the plain build imports a second module from /public, which the dev server refuses to transform).
    alias: { 'ort-bundle': path.resolve(here, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs') },
  },
  optimizeDeps: { exclude: ['ort-bundle'] },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
