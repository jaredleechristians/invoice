/**
 * Bumped after writes made outside the current page (e.g. the assistant saved
 * an expense). List and detail pages include it in their load watchers.
 */
export const useDataVersion = () => useState("data-version", () => 0);
