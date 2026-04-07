import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/id.js';
import type { LLMProvider, Message, ContentBlock, ToolUseBlock, ToolResultBlock, ChatChunk } from '../llm/types.js';
import type { ModelConfig } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentContext, ToolResult } from '../tools/types.js';

export interface AgentResult {
  success: boolean;
  summary: string;
  artifacts: string[];
  tokensUsed: { input: number; output: number };
  error?: string;
}

export abstract class BaseAgent {
  protected abstract get systemPrompt(): string;
  protected abstract get tools(): ToolRegistry;

  readonly id: string;
  private history: Message[] = [];
  private totalTokens = { input: 0, output: 0 };
  abort = false;

  private log: ReturnType<typeof createLogger>;

  constructor(
    protected readonly model: ModelConfig,
    protected readonly provider: LLMProvider,
    protected readonly context: AgentContext,
    protected readonly maxToolCalls: number = 50,
  ) {
    this.id = context.agentId;
    this.log = createLogger({ module: 'agent', agentId: this.id });
  }

  async run(initialMessage: string): Promise<AgentResult> {
    this.history = [];
    this.totalTokens = { input: 0, output: 0 };

    this.history.push({ role: 'user', content: initialMessage });

    let toolCallCount = 0;
    let lastTextBlock = '';
    let reportResultData: AgentResult | null = null;

    while (!this.abort) {
      // ── 1. Call LLM ──────────────────────────────────────────────────────
      const textChunks: string[] = [];
      const toolUseBlocks: ToolUseBlock[] = [];
      // Track tool inputs as they arrive (indexed by toolIndex)
      const pendingToolInputs = new Map<number, { id: string; name: string; input: Record<string, unknown> }>();

      let stopReason: string = 'end_turn';

      const stream = this.provider.streamChat({
        model: this.model.model,
        messages: this.history,
        tools: this.tools.getToolDefinitions(),
        temperature: 0.2,
        maxTokens: this.model.maxTokens,
        systemPrompt: this.systemPrompt,
      });

      for await (const chunk of stream) {
        if (this.abort) break;
        this.handleChunk(chunk, textChunks, pendingToolInputs, toolUseBlocks);
        if (chunk.type === 'usage' && chunk.usage) {
          this.totalTokens.input += chunk.usage.inputTokens;
          this.totalTokens.output += chunk.usage.outputTokens;
        }
        if (chunk.type === 'message_stop') {
          // stopReason comes from the stream metadata; approximate from content
          if (toolUseBlocks.length > 0) stopReason = 'tool_use';
        }
      }

      if (toolUseBlocks.length > 0) stopReason = 'tool_use';
      lastTextBlock = textChunks.join('');

      // ── 2. Add assistant turn to history ─────────────────────────────────
      const assistantContent: ContentBlock[] = [];
      if (lastTextBlock) assistantContent.push({ type: 'text', text: lastTextBlock });
      for (const tu of toolUseBlocks) assistantContent.push(tu);
      this.history.push({ role: 'assistant', content: assistantContent });

      // ── 3. Execute tools ─────────────────────────────────────────────────
      if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
        break; // end_turn or max_tokens — we're done
      }

      toolCallCount += toolUseBlocks.length;
      if (toolCallCount > this.maxToolCalls) {
        this.log.warn({ toolCallCount }, 'Max tool calls exceeded');
        await this.archiveHistory();
        return {
          success: false,
          summary: `Agent exceeded max tool calls (${this.maxToolCalls})`,
          artifacts: [],
          tokensUsed: this.totalTokens,
          error: 'max_tool_calls_exceeded',
        };
      }

      // All tool results for one assistant turn go in ONE user message.
      const toolResultBlocks: ToolResultBlock[] = [];
      for (const toolUse of toolUseBlocks) {
        // Check for report_result — this ends the loop immediately
        if (toolUse.name === 'report_result') {
          const p = toolUse.input as {
            success: boolean;
            summary: string;
            artifacts?: string[];
          };
          reportResultData = {
            success: p.success,
            summary: p.summary,
            artifacts: p.artifacts ?? [],
            tokensUsed: this.totalTokens,
          };
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Result reported. Task complete.',
          });
          break; // stop processing more tools in this turn
        }

        const result = await this.executeTool(toolUse);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.output + (result.error ? `\nError: ${result.error}` : ''),
          is_error: !result.success,
        });
      }

      this.history.push({ role: 'user', content: toolResultBlocks });

      if (reportResultData) break;
    }

    await this.archiveHistory();

    if (reportResultData) return reportResultData;

    return this.parseResult(lastTextBlock);
  }

  private handleChunk(
    chunk: ChatChunk,
    textChunks: string[],
    pendingToolInputs: Map<number, { id: string; name: string; input: Record<string, unknown> }>,
    toolUseBlocks: ToolUseBlock[],
  ): void {
    switch (chunk.type) {
      case 'text_delta':
        if (chunk.delta) {
          textChunks.push(chunk.delta);
          this.context.emitOutput(chunk.delta);
        }
        break;
      case 'tool_use_start':
        if (chunk.toolIndex !== undefined && chunk.toolId && chunk.toolName) {
          pendingToolInputs.set(chunk.toolIndex, {
            id: chunk.toolId,
            name: chunk.toolName,
            input: {},
          });
        }
        break;
      case 'tool_use_end':
        if (chunk.toolIndex !== undefined) {
          const meta = pendingToolInputs.get(chunk.toolIndex);
          if (meta) {
            toolUseBlocks.push({
              type: 'tool_use',
              id: meta.id,
              name: meta.name,
              input: chunk.toolInput ?? {},
            });
            pendingToolInputs.delete(chunk.toolIndex);
          }
        }
        break;
    }
  }

  private async executeTool(toolUse: ToolUseBlock): Promise<ToolResult> {
    const tool = this.tools.get(toolUse.name);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Unknown tool: ${toolUse.name}`,
      };
    }
    this.log.info({ tool: toolUse.name, input: toolUse.input }, 'Executing tool');
    try {
      const result = await tool.execute(toolUse.input, this.context);
      this.log.info(
        { tool: toolUse.name, success: result.success },
        'Tool completed',
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ tool: toolUse.name, err: msg }, 'Tool threw exception');
      return { success: false, output: '', error: msg };
    }
  }

  protected parseResult(lastTextBlock: string): AgentResult {
    return {
      success: true,
      summary: lastTextBlock.slice(0, 500),
      artifacts: [],
      tokensUsed: this.totalTokens,
    };
  }

  private async archiveHistory(): Promise<void> {
    try {
      const dir = path.join(
        this.context.workspaceRoot,
        '.aido',
        'agents',
        this.id,
      );
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'history.json'),
        JSON.stringify({ history: this.history, tokens: this.totalTokens }, null, 2),
        'utf-8',
      );
    } catch (err) {
      this.log.error({ err }, 'Failed to archive agent history');
    }
  }

  protected generateChildId(prefix: string): string {
    return generateId(prefix);
  }
}
