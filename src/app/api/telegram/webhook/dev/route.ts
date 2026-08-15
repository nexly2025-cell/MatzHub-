import { handleUpdate } from "../route";

export const dynamic = "force-dynamic";

/**
 * Developer bot webhook.
 *
 * Telegram permits one webhook per bot and the payload does not say which bot
 * received it, so the two bots need distinct URLs. Everything else — parsing,
 * authorisation, cleanup — is shared with the admin route; only the identity
 * differs, which selects the reply token, the webhook secret, the chat
 * allowlist and the command role.
 */
export async function POST(request: Request) {
  return handleUpdate(request, "dev");
}
