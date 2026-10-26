import { z } from 'zod';

export const uuid = z.uuid();
export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  settings: z.strictObject({
    language: z.literal('th').default('th'),
    targetDurationSeconds: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(60),
  }).default({ language: 'th', targetDurationSeconds: 60 }),
});
export const jobInput = z.strictObject({ kind: z.literal('system_check') });
export const idempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export type ProjectInput = z.infer<typeof projectInput>;
export type JobInput = z.infer<typeof jobInput>;
export type Project = ProjectInput & { id: string; createdAt: string };
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type Job = {
  id: string; projectId: string; kind: 'system_check'; status: JobStatus;
  attempts: number; result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdAt: string; updatedAt: string;
};
export interface Store {
  createProject(input: ProjectInput): Promise<Project>;
  createJob(projectId: string, input: JobInput, key: string): Promise<{ job: Job; created: boolean }>;
  getJob(id: string): Promise<Job | null>;
  ready(): Promise<boolean>;
}
export class DomainError extends Error {
  constructor(public code: 'NOT_FOUND' | 'CONFLICT') { super(code); }
}
