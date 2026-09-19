export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const firstLine = error.message.split("\n", 1)[0]?.trim();
  return firstLine || error.name || "Unknown error";
}
