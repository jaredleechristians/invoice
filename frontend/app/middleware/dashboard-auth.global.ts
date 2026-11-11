import { loginLocation, needsSignIn } from "~/utils/authRoutes";

// Every /dashboard route except login and invite links requires a signed-in user.
export default defineNuxtRouteMiddleware(async (to) => {
  if (!needsSignIn(to.path)) return;
  const { user, configured, waitUntilReady } = useAuth();
  await waitUntilReady();
  if (!configured.value || !user.value) return navigateTo(loginLocation(to.fullPath, to.path));
});
