export default defineNuxtRouteMiddleware(async (to) => {
  const { user, waitUntilReady } = useAuth();
  await waitUntilReady();

  if (!user.value) return;

  const redirect =
    typeof to.query.redirect === "string" && to.query.redirect.startsWith("/dashboard")
      ? to.query.redirect
      : "/dashboard";
  return navigateTo(redirect);
});
