<script setup lang="ts">
definePageMeta({ layout: "login", middleware: "guest" });

const route = useRoute();
const config = useRuntimeConfig().public;
const { user, configured, signInGoogle, ready } = useAuth();
const signingIn = ref(false);
const error = ref("");

const missingPublic = computed(() => {
  const checks: { key: string; label: string; ok: boolean }[] = [
    {
      key: "NUXT_PUBLIC_FIREBASE_API_KEY",
      label: "Web API key",
      ok: Boolean(config.firebaseApiKey),
    },
    {
      key: "NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      label: "Auth domain",
      ok: Boolean(config.firebaseAuthDomain),
    },
    {
      key: "NUXT_PUBLIC_FIREBASE_PROJECT_ID",
      label: "Project ID",
      ok: Boolean(config.firebaseProjectId),
    },
    {
      key: "NUXT_PUBLIC_FIREBASE_APP_ID",
      label: "App ID",
      ok: Boolean(config.firebaseAppId),
    },
  ];
  return checks.filter((c) => !c.ok);
});

async function onSignIn() {
  signingIn.value = true;
  error.value = "";
  try {
    await signInGoogle();
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "/dashboard";
    await navigateTo(redirect);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Sign-in failed";
  } finally {
    signingIn.value = false;
  }
}

watch(
  () => user.value?.uid,
  (uid) => {
    if (!uid || !ready.value) return;
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "/dashboard";
    navigateTo(redirect);
  }
);
</script>

<template>
  <UCard class="w-full max-w-md">
    <template #header>
      <h1 class="text-xl font-semibold">Sign in</h1>
      <p class="text-sm text-neutral-400 mt-1">
        Company workspace for customers, invoices, payments, and statements.
      </p>
    </template>

    <p class="text-sm text-neutral-300 mb-4">
      Sign-in uses <strong class="font-medium text-neutral-100">Google</strong> (Firebase
      Authentication). There is no separate email/password form — choose your Google account
      after tapping the button below.
    </p>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-4" />

    <UButton
      block
      size="lg"
      :loading="signingIn"
      :disabled="!configured"
      class="mb-4"
      @click="onSignIn"
    >
      Sign in with Google
    </UButton>

    <UAlert
      v-if="!configured"
      color="warning"
      variant="subtle"
      title="Firebase is not configured yet"
      class="mb-4"
    >
      <template #description>
        <p class="mb-2">
          Add your Firebase <strong>web app</strong> credentials to <code>.env</code>, enable
          <strong>Google</strong> as a sign-in provider in the Firebase console, then restart:
        </p>
        <p class="font-mono text-xs mb-2">docker compose up -d --build web api</p>
        <p v-if="missingPublic.length" class="text-sm">
          Missing:
          <ul class="list-disc pl-5 mt-1 space-y-0.5">
            <li v-for="item in missingPublic" :key="item.key">
              <code>{{ item.key }}</code> ({{ item.label }})
            </li>
          </ul>
        </p>
        <p class="text-sm mt-2 text-neutral-400">
          API also needs <code>FIREBASE_PROJECT_ID</code> and
          <code>FIREBASE_SERVICE_ACCOUNT_JSON</code> for tenant data. See
          <code>.env.example</code>.
        </p>
      </template>
    </UAlert>

    <UButton to="/" block variant="outline" color="neutral">
      Continue without an account
    </UButton>
  </UCard>
</template>
