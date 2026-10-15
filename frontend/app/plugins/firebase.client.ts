import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, onAuthStateChanged, type Auth, type User } from "firebase/auth";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const apiKey = config.public.firebaseApiKey;
  const projectId = config.public.firebaseProjectId;

  const user = useState<User | null>("auth-user", () => null);
  const ready = useState("auth-ready", () => false);

  let app: FirebaseApp | null = null;
  let auth: Auth | null = null;

  if (apiKey && projectId) {
    const firebaseConfig = {
      apiKey,
      authDomain: config.public.firebaseAuthDomain || undefined,
      projectId,
      appId: config.public.firebaseAppId || undefined,
    };
    app = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);
    auth = getAuth(app);
    onAuthStateChanged(auth, (u) => {
      user.value = u;
      ready.value = true;
    });
  } else {
    ready.value = true;
  }

  return {
    provide: {
      firebaseApp: app,
      firebaseAuth: auth,
    },
  };
});
