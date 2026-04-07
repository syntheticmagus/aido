import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { ModelsConfigSchema, type ModelsConfig } from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function interpolateEnvVars(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      // Leave the placeholder in place — Zod will validate it later.
      // This allows optional keys to remain undefined gracefully.
      return match;
    }
    return value;
  });
}

export async function loadModelsConfig(
  input: string,
  isFilePath = true,
): Promise<ModelsConfig> {
  let raw: string;
  if (isFilePath) {
    try {
      raw = await readFile(input, 'utf-8');
    } catch (err) {
      throw new ConfigError(`Cannot read models config file: ${input}`, err);
    }
  } else {
    raw = input;
  }

  const interpolated = interpolateEnvVars(raw);

  let parsed: unknown;
  try {
    parsed = parseYaml(interpolated);
  } catch (err) {
    throw new ConfigError('Invalid YAML in models config', err);
  }

  const result = ModelsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError('Models config validation failed', result.error.issues);
  }

  return result.data;
}

export async function loadSpec(input: string, isFilePath = true): Promise<string> {
  if (isFilePath) {
    try {
      return await readFile(input, 'utf-8');
    } catch (err) {
      throw new ConfigError(`Cannot read spec file: ${input}`, err);
    }
  }
  return input;
}
