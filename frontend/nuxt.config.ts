// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  future: {
    compatibilityVersion: 4,
  },
  ssr: false,
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      title: "Invoice",
      htmlAttrs: { lang: "en-ZA" },
      link: [
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossorigin: "",
        },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap",
        },
      ],
    },
  },
  runtimeConfig: {
    apiProxy: process.env.NUXT_API_PROXY || "http://127.0.0.1:8787",
  },
  nitro: {
    routeRules: {
      "/api/**": {
        proxy:
          (process.env.NUXT_API_PROXY || "http://127.0.0.1:8787") + "/api/**",
      },
    },
  },
  vite: {
    server: {
      proxy: {
        "/api": {
          target: process.env.NUXT_API_PROXY || "http://127.0.0.1:8787",
          changeOrigin: true,
        },
      },
    },
  },
  devtools: { enabled: false },
});
