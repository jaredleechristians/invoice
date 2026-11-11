import { loginLocation, needsSignIn } from "~/utils/authRoutes";

/**
 * Reacts to auth changes after the page has loaded (sign out, another tab
 * signing out, token revoked): clears tenant data and leaves the dashboard.
 */
export default defineNuxtPlugin(() => {
  const { user, ready, clearSessionData } = useAuth();
  const router = useRouter();

  watch(
    () => user.value?.uid,
    (uid, prev) => {
      if (!ready.value || uid) return;
      if (prev) clearSessionData();
      const route = router.currentRoute.value;
      if (needsSignIn(route.path)) router.replace(loginLocation(route.fullPath, route.path));
    }
  );
});
