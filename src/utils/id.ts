import { nanoid } from 'nanoid';

export function generateId(prefix?: string): string {
  const id = nanoid(12);
  return prefix ? `${prefix}-${id}` : id;
}

export function timestamp(): string {
  return new Date().toISOString();
}
