import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { AuthProvider, useAuth, type AuthContextProps } from "react-oidc-context";

export const CLIENT_ID = import.meta.env.VITE_SPACETIMEAUTH_CLIENT_ID ?? "";
const DEV_KEY = "pp.devMode";

const oidc = {
  authority: "https://auth.spacetimedb.com/oidc",
  client_id: CLIENT_ID || "missing-client-id",
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  scope: "openid profile email",
  response_type: "code" as const,
  automaticSilentRenew: true,
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, "/");
  },
};

interface DevMode {
  dev: boolean;
  setDev: (on: boolean) => void;
}

const DevModeContext = createContext<DevMode>({ dev: false, setDev: () => undefined });
const OidcContext = createContext<AuthContextProps | null>(null);

export function useDevMode() {
  return useContext(DevModeContext);
}

export function useOidc() {
  return useContext(OidcContext);
}

function OidcBridge({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return <OidcContext.Provider value={auth}>{children}</OidcContext.Provider>;
}

export function AuthRoot({ children }: { children: ReactNode }) {
  const [dev, setDevState] = useState(() => {
    const stored = localStorage.getItem(DEV_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return !CLIENT_ID;
  });
  const setDev = (on: boolean) => {
    localStorage.setItem(DEV_KEY, on ? "1" : "0");
    setDevState(on);
  };
  const devValue = useMemo(() => ({ dev, setDev }), [dev]);
  const app = (
    <DevModeContext.Provider value={devValue}>
      {CLIENT_ID ? (
        <AuthProvider {...oidc}>
          <OidcBridge>{children}</OidcBridge>
        </AuthProvider>
      ) : (
        children
      )}
    </DevModeContext.Provider>
  );
  return app;
}

export function emailOf(auth: AuthContextProps | null): string {
  const email = auth?.user?.profile.email;
  return typeof email === "string" ? email : "";
}
