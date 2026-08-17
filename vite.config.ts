import { defineConfig } from 'vite';

// GitHub Pages serves the project at /<repo>/ — everything must be relative so
// the same build also works from a custom domain or an S3 sub-path.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { port: 3017, host: true },
});
