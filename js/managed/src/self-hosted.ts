import worker, { type Env } from "./index";
import { ownerAccess, type OwnerAccessEnv } from "./owner-access";

export * from "./index";

export default {
  async fetch(request: Request, env: Env & OwnerAccessEnv, ctx: ExecutionContext) {
    const denied = await ownerAccess(request, env);
    return denied ?? worker.fetch(request, env, ctx);
  },
};
