import { GoogleAuthProvider, signInWithPopup, signOut, type User } from "firebase/auth";

export function useAuth() {
  const { $firebaseAuth } = useNuxtApp();
  const user = useState<User | null>("auth-user", () => null);
  const ready = useState("auth-ready", () => false);

  const configured = computed(() => Boolean($firebaseAuth));

  function waitUntilReady() {
    return new Promise<void>((resolve) => {
      if (ready.value) {
        resolve();
        return;
      }
      const stop = watch(
        ready,
        (isReady) => {
          if (isReady) {
            stop();
            resolve();
          }
        },
        { immediate: true }
      );
    });
  }

  async function signInGoogle() {
    if (!$firebaseAuth) throw new Error("Firebase is not configured");
    const provider = new GoogleAuthProvider();
    await signInWithPopup($firebaseAuth, provider);
  }

  /**
   * Forget everything tied to the previous user (company, tenant, page state).
   * States are reset to their defaults rather than cleared to `undefined`, so
   * mounted components reading them (layout navbar, PageHeader) never crash.
   */
  function clearSessionData() {
    useState("active-company").value = null;
    useState("active-company-loading").value = false;
    useState("active-company-id").value = null;
    useState("page-header").value = { title: "", info: "", owner: 0 };
    if (import.meta.client) localStorage.removeItem("activeCompanyId");
  }

  async function logout() {
    try {
      if ($firebaseAuth) await signOut($firebaseAuth);
    } finally {
      user.value = null;
      await navigateTo("/dashboard/login", { replace: true });
      clearSessionData();
    }
  }

  async function idToken() {
    if (!user.value) return "";
    return user.value.getIdToken();
  }

  return { user, ready, configured, signInGoogle, logout, idToken, waitUntilReady, clearSessionData };
}
