import { z } from 'zod';
import { generationInput, storedGenerationInput } from './script-contracts.js';

export const uuid = z.uuid();
export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  settings: z.strictObject({
    language: z.literal('th').default('th'),
    targetDurationSeconds: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(60),
  }).default({ language: 'th', targetDurationSeconds: 60 }),
});
const checkInput = z.strictObject({ kind: z.literal('system_check') });
export const jobInput = z.discriminatedUnion('kind', [checkInput, generationInput]);
export const storedJobInput = z.discriminatedUnion('kind', [checkInput, storedGenerationInput]);
export const idempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export type ProjectInput = z.infer<typeof projectInput>;
export type JobInput = z.infer<typeof jobInput>;
export type StoredJobInput = z.infer<typeof storedJobInput>;
export function jobRequest(input: StoredJobInput): JobInput {
  if (input.kind === 'system_check') return input;
  return { kind: input.kind, knowledgePackId: input.knowledgePackId, provider: input.provider, targetDurationSeconds: input.targetDurationSeconds, style: input.style };
}
export type Project = ProjectInput & { id: string; createdAt: string };
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type Job = {
  id: string; projectId: string; kind: JobInput['kind']; status: JobStatus;
  attempts: number; result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdAt: string; updatedAt: string;
};
export interface Store {
  createProject(input: ProjectInput): Promise<Project>;
  createJob(projectId: string, input: StoredJobInput, key: string): Promise<{ job: Job; created: boolean }>;
  getJobByKey(projectId: string, key: string): Promise<{ job: Job; input: JobInput } | null>;
  getJob(id: string): Promise<Job | null>;
  ready(): Promise<boolean>;
}
export class DomainError extends Error {
  constructor(public code: 'NOT_FOUND' | 'CONFLICT') { super(code); }
}
