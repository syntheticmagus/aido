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
  private consecutiveFailures = new Map<string, number>();
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
    this.consecutiveFailures = new Map();

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

        if (result.error === 'circuit_breaker_triggered') {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.output,
            is_error: true,
          });
          this.history.push({ role: 'user', content: toolResultBlocks });
          await this.archiveHistory();
          return {
            success: false,
            summary: result.output,
            artifacts: [],
            tokensUsed: this.totalTokens,
            error: 'circuit_breaker_triggered',
          };
        }

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
    // Validate required parameters declared in the tool schema before calling execute().
    // Some models (e.g. Gemma4) submit empty or partial tool calls; catch them here rather
    // than letting them throw deep inside tool implementations.
    const input = toolUse.input as Record<string, unknown>;
    for (const field of tool.parameters.required ?? []) {
      const val = input[field];
      if (val === undefined || val === null || (typeof val === 'string' && !val.trim())) {
        const err = `Missing required parameter: "${field}"`;
        this.log.info({ tool: toolUse.name, success: false, error: err }, 'Tool completed');
        return { success: false, output: '', error: err };
      }
    }

    this.log.info({ tool: toolUse.name, input: toolUse.input }, 'Executing tool');
    let result: ToolResult;
    try {
      result = await tool.execute(toolUse.input, this.context);
      this.log.info(
        {
          tool: toolUse.name,
          success: result.success,
          error: result.error,
          output: result.success ? undefined : result.output?.slice(0, 500),
        },
        'Tool completed',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ tool: toolUse.name, err: msg }, 'Tool threw exception');
      result = { success: false, output: '', error: msg };
    }

    // Circuit breaker: detect repeated identical failures
    const errorKey = `${toolUse.name}|${result.error ?? result.output}`;
    if (!result.success) {
      const count = (this.consecutiveFailures.get(errorKey) ?? 0) + 1;
      this.consecutiveFailures.set(errorKey, count);

      if (count >= 5) {
        return {
          success: false,
          output:
            `[CIRCUIT BREAKER] "${toolUse.name}" has failed ${count} consecutive times ` +
            `with the same error. Terminating to prevent a runaway loop.\nError: ${result.error}`,
          error: 'circuit_breaker_triggered',
        };
      }

      if (count >= 3) {
        return {
          ...result,
          output:
            (result.output ? result.output + '\n\n' : '') +
            `[WARNING] This is failure ${count} in a row for "${toolUse.name}" with the same error. ` +
            `You MUST change your approach — re-read the tool schema and supply all required parameters with non-empty values.`,
        };
      }
    } else {
      this.consecutiveFailures.delete(errorKey);
    }

    return result;
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
