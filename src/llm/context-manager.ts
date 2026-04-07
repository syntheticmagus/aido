import fs from 'node:fs/promises';
import path from 'node:path';
import { timestamp } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import type { LLMProvider, Message, ContentBlock } from './types.js';
import type { ModelConfig } from '../config/schema.js';

const log = createLogger({ module: 'context-manager' });

export class ContextManager {
  private history: Message[] = [];
  private turnCount = 0;
  private archiveDir: string | null = null;
  private agentId: string | null = null;

  constructor(
    private readonly provider: LLMProvider,
    private readonly model: ModelConfig,
    private readonly summarizeEveryNTurns: number = 20,
  ) {}

  setArchiveDir(dir: string, agentId: string): void {
    this.archiveDir = dir;
    this.agentId = agentId;
  }

  addTurn(role: 'user' | 'assistant', content: string | ContentBlock[]): void {
    this.history.push({ role, content });
    this.turnCount++;
  }

  async getMessages(): Promise<Message[]> {
    if (this.turnCount >= this.summarizeEveryNTurns) {
      await this.summarize();
    }
    return [...this.history];
  }

  private async summarize(): Promise<void> {
    log.info({ turns: this.turnCount }, 'Summarizing Team Lead conversation history');

    // Archive full history first
    if (this.archiveDir && this.agentId) {
      try {
        const archivePath = path.join(
          this.archiveDir,
          `history-archive-${timestamp()}.json`,
        );
        await fs.mkdir(this.archiveDir, { recursive: true });
        await fs.writeFile(
          archivePath,
          JSON.stringify({ history: this.history }, null, 2),
          'utf-8',
        );
        log.info({ archivePath }, 'Archived full history');
      } catch (err) {
        log.error({ err }, 'Failed to archive history');
      }
    }

    const summaryRequest = {
      model: this.model.model,
      systemPrompt:
        'You are a summarization assistant. Summarize this conversation history ' +
        'precisely, preserving all task statuses, decisions made, agent assignments, ' +
        'and open questions. Be thorough — this summary replaces the full history.',
      messages: this.history,
      temperature: 0.1,
      maxTokens: 4096,
    };

    let summaryText = '';
    try {
      const stream = this.provider.streamChat(summaryRequest);
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta' && chunk.delta) {
          summaryText += chunk.delta;
        }
      }
    } catch (err) {
      log.error({ err }, 'Summarization failed — keeping full history');
      return;
    }

    // Replace history with compact summary
    this.history = [
      {
        role: 'user',
        content: '[CONVERSATION SUMMARY — earlier turns have been archived to disk]',
      },
      { role: 'assistant', content: summaryText },
    ];
    this.turnCount = 0;
    log.info('Context summarized successfully');
  }
}
