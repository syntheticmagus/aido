import type { Tool } from './types.js';
import type { ToolDefinition } from '../llm/types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  // Returns tool definitions in the format expected by LLM providers.
  getToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));
  }

  // Returns a new ToolRegistry containing only the named tools.
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) sub.register(tool);
    }
    return sub;
  }
}
