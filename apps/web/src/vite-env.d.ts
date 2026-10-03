/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPACETIMEDB_URI?: string;
  readonly VITE_SPACETIMEDB_DB?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_SPACETIMEAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
