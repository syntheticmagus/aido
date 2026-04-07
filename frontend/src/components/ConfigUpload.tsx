import { useState } from 'react';

const DEFAULT_MODELS_YAML = `models:
  - id: claude-sonnet
    provider: anthropic
    model: claude-sonnet-4-5
    apiKey: \${ANTHROPIC_API_KEY}
    roles: [developer, reviewer, tester, debugger, docs]
    costPer1kInput: 0.003
    costPer1kOutput: 0.015
  - id: claude-opus
    provider: anthropic
    model: claude-opus-4-5
    apiKey: \${ANTHROPIC_API_KEY}
    roles: [team-lead, architect]
    costPer1kInput: 0.015
    costPer1kOutput: 0.075

budget:
  maxTotalCost: 10.00
  warnAtCost: 8.00
  maxWallClockHours: 2
`;

interface ValidationResult {
  valid: boolean;
  errors?: string[];
  detected?: { models: string[]; roles: Record<string, string[]> };
}

export function ConfigUpload() {
  const [modelsYaml, setModelsYaml] = useState(DEFAULT_MODELS_YAML);
  const [specMd, setSpecMd] = useState('');
  const [projectName, setProjectName] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = async () => {
    setValidating(true);
    setValidation(null);
    setError(null);
    try {
      const res = await fetch('/api/config/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelsYaml, specMd }),
      });
      const data = await res.json() as ValidationResult;
      setValidation(data);
    } catch (err) {
      setError('Validation request failed: ' + (err as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const startProject = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/project/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelsYaml, specMd, projectName: projectName || undefined }),
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        setError(data.error);
      }
    } catch (err) {
      setError('Start failed: ' + (err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-2 text-white">AIDO</h1>
        <p className="text-gray-400 mb-8">Autonomous AI Development Orchestrator — Setup</p>

        <div className="grid grid-cols-2 gap-6 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              models.yaml
            </label>
            <textarea
              className="w-full h-72 bg-gray-900 border border-gray-700 rounded-lg p-3 font-mono text-sm text-gray-200 resize-none focus:outline-none focus:border-blue-500"
              value={modelsYaml}
              onChange={(e) => setModelsYaml(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              spec.md — Project Specification
            </label>
            <textarea
              className="w-full h-72 bg-gray-900 border border-gray-700 rounded-lg p-3 font-mono text-sm text-gray-200 resize-none focus:outline-none focus:border-blue-500"
              value={specMd}
              onChange={(e) => setSpecMd(e.target.value)}
              placeholder="# Project: My App&#10;&#10;## Overview&#10;What this software does...&#10;&#10;## Features&#10;..."
              spellCheck={false}
            />
          </div>
        </div>

        <div className="flex items-center gap-4 mb-6">
          <input
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 focus:outline-none focus:border-blue-500"
            placeholder="Project name (optional)"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          />
          <button
            onClick={validate}
            disabled={validating || !modelsYaml}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {validating ? 'Validating...' : 'Validate Config'}
          </button>
          <button
            onClick={startProject}
            disabled={starting || !modelsYaml || !specMd || (validation !== null && !validation.valid)}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {starting ? 'Starting...' : 'Start Project'}
          </button>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-4 text-red-300">
            {error}
          </div>
        )}

        {validation && (
          <div className={`rounded-lg p-4 mb-4 ${validation.valid ? 'bg-green-900/30 border border-green-700' : 'bg-red-900/30 border border-red-700'}`}>
            {validation.valid ? (
              <div>
                <p className="font-medium text-green-300 mb-2">✓ Config valid</p>
                <p className="text-sm text-gray-400">
                  Models: {validation.detected?.models.join(', ')}
                </p>
                <p className="text-sm text-gray-400">
                  Roles: {Object.entries(validation.detected?.roles ?? {}).map(([r, ms]) => `${r} → ${ms.join(', ')}`).join(' | ')}
                </p>
              </div>
            ) : (
              <div>
                <p className="font-medium text-red-300 mb-2">✗ Config invalid</p>
                {validation.errors?.map((e, i) => (
                  <p key={i} className="text-sm text-red-400">{e}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
