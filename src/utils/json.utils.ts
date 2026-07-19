export function stripJsonCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
}
