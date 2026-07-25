/** ISO-8601 UTC — формат, в котором даты сортируются лексикографически. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
