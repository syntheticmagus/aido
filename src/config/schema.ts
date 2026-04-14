import { z } from 'zod';

export const AgentRoleSchema = z.enum([
  'team-lead',    // reserved for the orchestrator's persistent planner
  'architecture',
  'implement',
  'test',
  'review',
  'debug',
  'devops',
  'docs',
  'integrate',
  'validate',
  'default',      // fallback: used when no dedicated model matches a role
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TaskTypeSchema = z.enum([
  'architecture',
  'implement',
  'test',
  'review',
  'debug',
  'devops',
  'docs',
  'integrate',
  'validate',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'blocked',
  'assigned',
  'in-progress',
  'review',
  'done',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ModelConfigSchema = z.object({
  id: z.string(),
  provider: z.enum(['anthropic', 'openai', 'google', 'local']),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  maxTokens: z.number().int().positive().default(32768),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().positive(),
      tokensPerMinute: z.number().positive(),
    })
    .optional(),
  roles: z.array(AgentRoleSchema),
  costPer1kInput: z.number().nonnegative().default(0),
  costPer1kOutput: z.number().nonnegative().default(0),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ClaudeCodeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  binaryPath: z.string().default('claude'),
  maxConcurrentSessions: z.number().int().positive().default(1),
  usageLimitCooldownMinutes: z.number().positive().default(60),
  timeoutMinutes: z.number().positive().default(10),
  reserveForRoles: z.array(z.string()).default([]),
});
export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfigSchema>;

export const BudgetSchema = z.object({
  maxTotalCost: z.number().positive(),
  warnAtCost: z.number().positive().optional(),
  maxWallClockHours: z.number().positive().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ModelsConfigSchema = z
  .object({
    models: z.array(ModelConfigSchema).min(1),
    claudeCode: ClaudeCodeConfigSchema.optional(),
    defaults: z
      .object({
        temperature: z.number().min(0).max(1).default(0.2),
        retryAttempts: z.number().int().positive().default(3),
        retryBackoffMs: z.number().positive().default(1000),
        maxConcurrentAgents: z.number().int().positive().default(5),
        maxToolCallsPerTurn: z.number().int().positive().default(100),
        contextSummarizeEveryNTurns: z.number().int().positive().default(20),
      })
      .default({}),
    budget: BudgetSchema,
  })
  .refine(
    (cfg) => cfg.models.some((m) => m.roles.includes('default')),
    {
      message:
        "At least one model must include the 'default' role. " +
        "This model is used as a fallback for any task type that has no dedicated model configured.",
    },
  );
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const TaskResultSchema = z.object({
  success: z.boolean(),
  summary: z.string(),
  artifacts: z.array(z.string()).default([]),
  tokensUsed: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  cost: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: TaskTypeSchema,
  status: TaskStatusSchema,
  dependencies: z.array(z.string()).default([]),
  assignedAgent: z.string().optional(),
  assignedModel: z.string().optional(),
  priority: z.number().int().default(5),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  artifacts: z.array(z.string()).default([]),
  result: TaskResultSchema.optional(),
  createdBy: z.string(),
  estimatedTokens: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;
