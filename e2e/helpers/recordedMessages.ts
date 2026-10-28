export interface RecordedServerMessage {
  type: string;
  [key: string]: unknown;
}

/** Wait without draining the recorder: unrelated frames remain available to later assertions. */
export async function waitForRecordedMessage(
  readMessages: () => Promise<RecordedServerMessage[]>,
  match: Partial<RecordedServerMessage>,
  timeoutMs = 10_000,
): Promise<RecordedServerMessage> {
  const deadline = Date.now() + timeoutMs;
  const fields = Object.entries(match);
  if (fields.length === 0) throw new Error('A recorded-message matcher is required');
  while (true) {
    const messages = await readMessages();
    const found = messages.find((message) =>
      fields.every(([key, value]) => message[key] === value),
    );
    if (found) return found;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Report protocol identity, not message bodies (which may contain user output).
      const observed = messages.slice(-30).map(({ type, id, toolId }) => ({ type, id, toolId }));
      throw new Error(
        `Timed out waiting for recorded WebSocket message ${JSON.stringify(match)}; ` +
          `observed identities: ${JSON.stringify(observed)}. See standalone host logs for hook processing.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}
