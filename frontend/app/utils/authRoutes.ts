/** Dashboard routes that may render without a signed-in user. */
export function isPublicDashboardPath(path: string) {
  return path === "/dashboard/login" || path.startsWith("/dashboard/invite/");
}

export function needsSignIn(path: string) {
  return (path === "/dashboard" || path.startsWith("/dashboard/")) && !isPublicDashboardPath(path);
}

export function loginLocation(fullPath: string, path: string) {
  return { path: "/dashboard/login", query: path === "/dashboard" ? {} : { redirect: fullPath } };
}
