export function newId(): string {
  return crypto.randomUUID();
}

/** Нормализация ключей, имён тегов и коллекций для регистронезависимого поиска. */
export function norm(value: string): string {
  return value.trim().toLowerCase();
}
