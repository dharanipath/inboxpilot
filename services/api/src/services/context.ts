import type { User } from "@prisma/client";

import type { UserContext } from "../agent/types.js";

export function userContext(user: User, now: Date): UserContext {
  return {
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    now: now.toISOString(),
    vip_senders: user.vipSenders,
  };
}
