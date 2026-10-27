import { readStorageConfig } from '../../packages/core/src/config.js';
import { S3Storage } from '../../packages/core/src/storage.js';

const storage = new S3Storage(readStorageConfig());
try { await storage.initialize(); console.log('Private storage bucket ready'); }
catch { console.error('Storage initialization failed; check endpoint, credentials and bucket permissions'); process.exitCode = 1; }
finally { storage.close(); }
