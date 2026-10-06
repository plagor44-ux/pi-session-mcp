/**
 * What a scripted model runtime can observe about the tools Pi offers.
 *
 * Since Pi SDK 0.99 the context handed to `streamSimple` carries only `messages`: the
 * model-visible tools are declared on transcript system messages (`toolsAdded` /
 * `toolsRemoved`), while `context.tools` no longer exists. Replaying those declarations
 * yields exactly the set the model may call on this request.
 */
export interface DeclaringMessage {
  readonly role?: string;
  readonly toolsAdded?: ReadonlyArray<{ readonly name: string }>;
  readonly toolsRemoved?: ReadonlyArray<string | { readonly name: string }>;
}

export function declaredTools(messages: ReadonlyArray<DeclaringMessage> = []): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === "string" ? tool : tool.name);
  }
  return [...names].sort();
}
