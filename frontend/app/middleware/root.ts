// Signed-in visitors hitting / should go to the dashboard, without first
// painting the public editor. Signed-out visitors stay on the landing page.
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path !== "/") return;
  const { user, waitUntilReady } = useAuth();
  await waitUntilReady();
  if (user.value) return navigateTo("/dashboard", { replace: true });
});
