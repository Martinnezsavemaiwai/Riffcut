import { expect, it } from 'vitest';
import { configuredScriptProviders } from '../../packages/core/src/script-providers.js';
import { validateDraft } from '../../packages/core/src/script-contracts.js';
import { pack, request } from '../fixtures/scripts.js';
import { randomUUID } from 'node:crypto';

const richerPack = { ...pack, transcriptSegments: [
  { id: randomUUID(), startMs: 0, endMs: 10000, text: 'โครงการห้องสมุดชุมชนเปิดทุกวันเสาร์ ตั้งแต่เก้าโมงเช้าถึงสี่โมงเย็น' },
  { id: randomUUID(), startMs: 10000, endMs: 20000, text: 'สมาชิกยืมหนังสือได้ครั้งละสองเล่ม เป็นเวลาเจ็ดวัน โดยไม่มีค่าสมาชิก' },
  { id: randomUUID(), startMs: 20000, endMs: 30000, text: 'ผู้สนใจสมัครสมาชิกได้ที่เคาน์เตอร์ห้องสมุด โดยนำบัตรประชาชนมาแสดง' },
] };
it.skipIf(process.env.RUN_OLLAMA_LIVE_TESTS !== '1').each([pack, richerPack])('live local Ollama: grounded Thai script and usage %#', async inputPack => {
  const provider = configuredScriptProviders().ollama;
  if (!provider) throw new Error('Configure OLLAMA_MODEL and start Ollama first');
  const result = await provider.generate({ pack: inputPack, request: { ...request, provider: 'ollama', model: provider.model } });
  const draft = validateDraft(result.output, inputPack, 30);
  expect(draft.segments.length).toBeGreaterThan(0);
  expect(draft.segments.some(segment => /[ก-๙]/.test(segment.text))).toBe(true);
  expect(result.usage.outputTokens).toBeGreaterThan(0);
}, 190000);
