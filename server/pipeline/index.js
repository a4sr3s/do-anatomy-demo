import { MockPipeline } from './mock.js';

/** Build the pipeline selected by PIPELINE_MODE. Real-mode module is imported lazily. */
export async function createPipeline(bus, env = process.env, overrides = {}) {
  const mode = (overrides.mode || env.PIPELINE_MODE || 'mock').toLowerCase();
  if (mode === 'real') {
    const { RealPipeline } = await import('./real.js');
    return new RealPipeline(bus, env);
  }
  if (mode !== 'mock') console.warn(`Unknown PIPELINE_MODE "${mode}", using mock`);
  const delayScale = overrides.delayScale ?? (env.MOCK_DELAY_SCALE !== undefined ? Number(env.MOCK_DELAY_SCALE) : 1);
  return new MockPipeline(bus, { delayScale });
}
