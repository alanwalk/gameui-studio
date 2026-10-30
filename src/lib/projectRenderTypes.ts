import type { ScreenVersion } from '../types';

export type ProjectRenderInput = {
  /** Also the reserved version ID; reuse it when a POST response is lost. */
  id: string;
  projectId: string;
  screenId: string;
  operation: 'generate' | 'refine';
  sourceVersionId?: string;
  sourceImage?: string;
  prompt: string;
  styleSnapshot?: ScreenVersion['styleSnapshot'];
  size: string;
  wireframe?: string;
};

export type ProjectRenderTask = Omit<ProjectRenderInput, 'wireframe'> & {
  createdAt: number;
  status: 'queued' | 'running' | 'interrupted' | 'failed' | 'done' | 'acknowledged' | 'discarded';
  result?: string;
  error?: string;
};
