import { onAuthStateChanged } from "firebase/auth";
import { loginLocation, needsSignIn } from "~/utils/authRoutes";

/**
 * Reacts to auth changes after the page has loaded (sign out, another tab
 * signing out, token expired or revoked): whenever the Firebase user becomes
 * null on a protected /dashboard route, clear tenant data and go to login.
 * Runs after 01.firebase.client.ts, which provides $firebaseAuth.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const auth = nuxtApp.$firebaseAuth as import("firebase/auth").Auth | null;
  if (!auth) return;
  const router = useRouter();
  const { clearSessionData } = useAuth();
  let hadUser = false;

  onAuthStateChanged(auth, async (u) => {
    if (u) {
      hadUser = true;
      return;
    }
    const route = router.currentRoute.value;
    if (needsSignIn(route.path)) {
      await navigateTo(loginLocation(route.fullPath, route.path), { replace: true });
    }
    if (hadUser) clearSessionData();
    hadUser = false;
  });
});
