import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/azentrix-fullstack-task1/' : './',
  server: {
    port: 3000,
    open: true
  }
});
