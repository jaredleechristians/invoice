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

  async function logout() {
    if (!$firebaseAuth) return;
    await signOut($firebaseAuth);
  }

  async function idToken() {
    if (!user.value) return "";
    return user.value.getIdToken();
  }

  return { user, ready, configured, signInGoogle, logout, idToken, waitUntilReady };
}
