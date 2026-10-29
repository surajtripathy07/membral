// Wiring for the route handler: real store (service-role PostgREST client), the app's JWT secret and port.
import { getServiceClient } from "@/lib/db/clients";
import { appPort, supabaseJwtSecret } from "@/lib/env";
import { handleAuthRequest } from "./handler";
import { createRpcStore } from "./store";

export { handleAuthRequest } from "./handler";

export function handleLocalAuth(req: Request, path: string[]): Promise<Response> {
  return handleAuthRequest(req, path, {
    store: createRpcStore(getServiceClient()),
    jwtSecret: supabaseJwtSecret(),
    port: appPort(),
  });
}
