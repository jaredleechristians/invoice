<script setup lang="ts">
definePageMeta({ layout: "login", middleware: "guest" });

const route = useRoute();
const config = useRuntimeConfig().public;
const { user, configured, signInGoogle, ready } = useAuth();
const signingIn = ref(false);
const error = ref("");

const usingEmulator = computed(() => Boolean(config.firebaseAuthEmulatorHost));

const missingPublic = computed(() =>
  [
    { key: "NUXT_PUBLIC_FIREBASE_API_KEY", label: "Web API key", ok: Boolean(config.firebaseApiKey) },
    { key: "NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN", label: "Auth domain", ok: Boolean(config.firebaseAuthDomain) },
    { key: "NUXT_PUBLIC_FIREBASE_PROJECT_ID", label: "Project ID", ok: Boolean(config.firebaseProjectId) },
    { key: "NUXT_PUBLIC_FIREBASE_APP_ID", label: "App ID", ok: Boolean(config.firebaseAppId) },
  ].filter((c) => !c.ok)
);

function redirectTarget() {
  const r = route.query.redirect;
  // Only allow in-app paths (avoid open redirects).
  return typeof r === "string" && r.startsWith("/") && !r.startsWith("//") ? r : "/dashboard";
}

function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code || "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "";
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in popup. Allow popups for this site and try again.";
    case "auth/unauthorized-domain":
      return "This domain isn't authorised for sign-in. Add it under Firebase Console → Authentication → Settings → Authorised domains.";
    case "auth/operation-not-allowed":
      return "Google sign-in is not enabled for this Firebase project.";
    case "auth/network-request-failed":
      return "Network error while contacting Google. Check your connection and try again.";
    default:
      return e instanceof Error ? e.message : "Sign-in failed";
  }
}

async function onSignIn() {
  if (signingIn.value) return;
  signingIn.value = true;
  error.value = "";
  try {
    await signInGoogle();
    await navigateTo(redirectTarget());
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    signingIn.value = false;
  }
}

watch(
  () => user.value?.uid,
  (uid) => {
    if (!uid || !ready.value) return;
    navigateTo(redirectTarget());
  }
);
</script>

<template>
  <UCard
    class="w-full max-w-sm shadow-xl shadow-black/5 dark:shadow-black/30"
    :ui="{ body: 'p-6 sm:p-8' }"
  >
    <div class="flex flex-col items-center text-center">
      <div class="flex size-12 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
        <UIcon name="i-lucide-receipt-text" class="size-6 text-primary" />
      </div>
      <h1 class="mt-4 text-xl font-semibold text-highlighted">Sign in to Invoice</h1>
    </div>

    <div class="mt-6 space-y-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Sign-in failed"
        :description="error"
        :close="{ color: 'error', variant: 'link' }"
        @update:open="error = ''"
      />

      <UButton
        block
        size="lg"
        color="neutral"
        variant="outline"
        icon="i-app-google"
        label="Continue with Google"
        :loading="signingIn"
        :disabled="!configured || signingIn"
        @click="onSignIn"
      />

      <UAlert
        v-if="configured && usingEmulator"
        color="info"
        variant="subtle"
        icon="i-lucide-flask-conical"
        title="Local emulator"
        description="Sign-in uses the Firebase Auth emulator, so a test account picker opens instead of Google."
      />

      <UAlert
        v-if="!configured"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Firebase is not configured yet"
      >
        <template #description>
          <div class="space-y-2 text-sm">
            <p>
              Add your Firebase <strong>web app</strong> config to <code>.env</code>, enable
              <strong>Google</strong> as a sign-in provider in the Firebase console, then restart:
            </p>
            <p class="font-mono text-xs">docker compose up -d --build web api</p>
            <div v-if="missingPublic.length">
              Missing:
              <ul class="list-disc pl-5 mt-1 space-y-0.5">
                <li v-for="item in missingPublic" :key="item.key">
                  <code>{{ item.key }}</code> ({{ item.label }})
                </li>
              </ul>
            </div>
            <p class="text-muted">
              The API also needs <code>FIREBASE_PROJECT_ID</code> and
              <code>FIREBASE_SERVICE_ACCOUNT_JSON</code>. See <code>.env.example</code>.
            </p>
          </div>
        </template>
      </UAlert>

      <USeparator label="or" />

      <UButton
        to="/"
        block
        size="lg"
        color="neutral"
        variant="soft"
        icon="i-lucide-file-pen"
        label="Continue without an account"
      />
    </div>
  </UCard>
</template>
