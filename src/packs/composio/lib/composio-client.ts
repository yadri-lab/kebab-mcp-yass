import { Composio } from "composio-core";

let client: Composio | null = null;

export function getComposioClient(): Composio {
  if (!client) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error("COMPOSIO_API_KEY not configured");
    client = new Composio({ apiKey });
  }
  return client;
}

export async function executeAction(
  actionName: string,
  params: Record<string, unknown>,
  entityId?: string
): Promise<string> {
  const composio = getComposioClient();
  const entity = composio.getEntity(entityId || process.env.COMPOSIO_ENTITY_ID || "default");
  const result = await entity.execute({ actionName, params } as Parameters<
    typeof entity.execute
  >[0]);

  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export async function listAvailableActions(appName: string): Promise<string[]> {
  const composio = getComposioClient();
  const actions = await composio.actions.list({ apps: appName });
  const items = (actions as unknown as { items?: { name: string }[] }).items || [];
  return items.map((a) => a.name);
}
