import { Router } from 'express';
import type { Server } from 'socket.io';
import { loadModelsConfig, loadSpec } from '../../config/loader.js';
import type { Orchestrator } from '../../orchestrator/orchestrator.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import { generateId } from '../../utils/id.js';

export function createApiRouter(
  _io: Server,
  orchestrator: Orchestrator,
  workspaceManager: WorkspaceManager,
) {
  const router = Router();

  // POST /api/config/validate
  router.post('/config/validate', async (req, res) => {
    const { modelsYaml, specMd } = req.body as {
      modelsYaml?: string;
      specMd?: string;
    };

    if (!modelsYaml) {
      res.status(400).json({ valid: false, errors: ['modelsYaml is required'] });
      return;
    }

    try {
      const config = await loadModelsConfig(modelsYaml, false);
      const detected: Record<string, string[]> = {};
      for (const model of config.models) {
        for (const role of model.roles) {
          (detected[role] ??= []).push(model.id);
        }
      }
      res.json({
        valid: true,
        detected: { models: config.models.map((m) => m.id), roles: detected },
        budget: config.budget,
      });
    } catch (err) {
      res.status(422).json({
        valid: false,
        errors: [(err as Error).message],
      });
    }
  });

  // POST /api/project/start
  router.post('/project/start', async (req, res) => {
    const { modelsYaml, specMd, projectName } = req.body as {
      modelsYaml?: string;
      specMd?: string;
      projectName?: string;
    };

    if (!modelsYaml || !specMd) {
      res.status(400).json({ error: 'modelsYaml and specMd are required' });
      return;
    }

    const name = projectName ?? `project-${generateId()}`;

    try {
      const config = await loadModelsConfig(modelsYaml, false);
      const spec = await loadSpec(specMd, false);
      await orchestrator.start(name, spec, config);
      res.json({ projectId: name });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/project/status
  router.get('/project/status', (_req, res) => {
    res.json(orchestrator.getStatus());
  });

  // POST /api/project/pause
  router.post('/project/pause', (_req, res) => {
    orchestrator.pause();
    res.json({ ok: true });
  });

  // POST /api/project/resume
  router.post('/project/resume', (_req, res) => {
    orchestrator.resume();
    res.json({ ok: true });
  });

  // GET /api/tasks
  router.get('/tasks', (_req, res) => {
    res.json(orchestrator.getTasks());
  });

  // GET /api/agents
  router.get('/agents', (_req, res) => {
    res.json(orchestrator.getActiveAgents());
  });

  // GET /api/budget
  router.get('/budget', (_req, res) => {
    res.json(orchestrator.getBudget());
  });

  return router;
}
