export default defineNuxtRouteMiddleware(async (to) => {
  const { user, configured, waitUntilReady } = useAuth();
  await waitUntilReady();

  if (to.path === "/dashboard/login") return;

  if (!configured.value || !user.value) {
    return navigateTo({
      path: "/dashboard/login",
      query: to.path === "/dashboard" ? {} : { redirect: to.fullPath },
    });
  }
});
