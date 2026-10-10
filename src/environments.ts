// Where each build talks to: the sync API (every request the extension makes) and the web app (the
// one page it opens, /connect/extension). The build picks one by its mode (`vite build --mode`) and
// bakes it in; nothing at run time can change it.

export type EnvironmentName = "development" | "staging" | "production";

export interface Environment {
  readonly name: EnvironmentName;
  /** The sync API's origin, without a trailing slash. */
  readonly apiOrigin: string;
  /** The web app's origin, without a trailing slash. */
  readonly appOrigin: string;
}

export const ENVIRONMENTS: Readonly<Record<EnvironmentName, Environment>> = {
  // the local sync API (wrangler dev) and the local web app
  development: {
    name: "development",
    apiOrigin: "http://localhost:8790",
    appOrigin: "http://localhost:3005",
  },
  staging: {
    name: "staging",
    apiOrigin: "https://api-staging.knowtarium.com",
    appOrigin: "https://app-staging.knowtarium.com",
  },
  production: {
    name: "production",
    apiOrigin: "https://api.knowtarium.com",
    appOrigin: "https://app.knowtarium.com",
  },
};

/** The environment for a build mode; anything else is refused, so a typo can't ship. */
export function environmentFor(mode: string): Environment {
  if (mode === "development" || mode === "staging" || mode === "production") {
    return ENVIRONMENTS[mode];
  }
  throw new Error(`unknown build mode "${mode}": use development, staging or production`);
}
