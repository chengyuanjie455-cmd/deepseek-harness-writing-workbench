import { defineConfig } from 'vite';
export default defineConfig({ root: 'web', build: { outDir: '../dist', emptyOutDir: true, manifest:'ui-module-map.json' }, server: { proxy: { '/api': 'http://127.0.0.1:4317' } } });
