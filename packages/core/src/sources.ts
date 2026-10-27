import { z } from 'zod';

export const rightsInput = z.strictObject({ basis: z.enum(['owner', 'licensed', 'permission']), attestation: z.literal(true), notes: z.string().trim().min(1).max(1000) });
export type RightsInput = z.infer<typeof rightsInput>;
export type MediaMetadata = { durationMs: number; width: number; height: number; videoCodec: 'h264' | 'hevc'; audioCodec: 'aac' | 'mp3' | null; hasAudio: boolean };
export type Source = {
  id: string; assetId: string; projectId: string; status: 'uploading' | 'ready' | 'failed';
  originalFilename: string; sizeBytes: number; metadata: MediaMetadata;
  rights: { basis: RightsInput['basis']; notes: string; attestedAt: string };
  error: { code: string; message: string } | null; createdAt: string;
};
export type Asset = { id: string; sourceId: string; projectId: string; kind: 'source_video'; status: 'pending' | 'ready' | 'failed'; contentType: 'video/mp4'; sizeBytes: number; metadata: MediaMetadata; createdAt: string };
export type UploadDraft = { sourceId: string; assetId: string; projectId: string; key: string; filename: string; sizeBytes: number; metadata: MediaMetadata; rights: RightsInput };
export interface SourceRepository {
  projectExists(id: string): Promise<boolean>;
  beginUpload(input: UploadDraft): Promise<Source>;
  markReady(sourceId: string): Promise<Source>;
  markFailed(sourceId: string): Promise<void>;
  getSource(projectId: string, sourceId: string): Promise<Source | null>;
  listSources(projectId: string): Promise<Source[]>;
  listAssets(projectId: string): Promise<Asset[]>;
}
export interface PrivateStorage {
  put(key: string, path: string, size: number): Promise<void>;
  remove(key: string): Promise<void>;
  ready(): Promise<boolean>;
}
export class SourceError extends Error {
  constructor(public code: 'INVALID_MEDIA' | 'INVALID_UPLOAD' | 'UPLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'STORAGE_UNAVAILABLE' | 'MEDIA_UNAVAILABLE', public statusCode: number, message: string) { super(message); }
}
