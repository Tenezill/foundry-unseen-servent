export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',

  // Token lives in localStorage; the app is a pure client of the gateway.
  ssr: false,

  modules: ['@vite-pwa/nuxt'],

  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  typescript: {
    tsConfig: {
      compilerOptions: {
        paths: {
          // Types-only import of the adapter contract (SheetViewModel & co).
          // All app imports are `import type`, so Vite never resolves this;
          // the path is relative to the generated .nuxt/tsconfig.json.
          '@companion/adapter-sdk': ['../../../packages/adapter-sdk/src/index.ts'],
        },
      },
    },
  },

  runtimeConfig: {
    public: {
      /** Gateway base URL; '' = same-origin (prod default behind Caddy). */
      apiBase: '',
    },
  },

  nitro: {
    devProxy: {
      '/api': { target: 'http://localhost:8090/api', changeOrigin: true },
    },
    prerender: { routes: ['/'] },
  },

  app: {
    head: {
      title: 'Foundry Companion',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#111318' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      ],
    },
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'Foundry Companion',
      short_name: 'Companion',
      description: 'Your character sheet, live from the table.',
      theme_color: '#111318',
      background_color: '#111318',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '/',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      navigateFallback: '/',
      // API traffic must never be swallowed by the SW; offline sheet
      // fallback is handled in-app via localStorage snapshots.
      navigateFallbackDenylist: [/^\/api\//, /^\/healthz/],
      runtimeCaching: [],
    },
    client: {
      installPrompt: false,
    },
  },
})
