// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  future: {
    compatibilityVersion: 4,
  },
  modules: ["@nuxt/ui"],
  icon: {
    // Small local SVG set (e.g. i-app-google) — no extra icon packages needed.
    customCollections: [{ prefix: "app", dir: "./app/assets/icons" }],
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
    public: {
      firebaseApiKey: process.env.NUXT_PUBLIC_FIREBASE_API_KEY || "",
      firebaseAuthDomain: process.env.NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
      firebaseProjectId: process.env.NUXT_PUBLIC_FIREBASE_PROJECT_ID || "",
      firebaseAppId: process.env.NUXT_PUBLIC_FIREBASE_APP_ID || "",
      // Local dev only: e.g. http://localhost:9099 (see docker-compose.emulators.yml)
      firebaseAuthEmulatorHost: process.env.NUXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST || "",
    },
  },
  nitro: {
    routeRules: {
      "/api/**": {
        proxy:
          (process.env.NUXT_API_PROXY || "http://127.0.0.1:8787") + "/api/**",
      },
      "/dashboard/**": { ssr: false },
      "/app": { redirect: "/dashboard/login" },
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
