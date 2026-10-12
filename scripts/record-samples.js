// Regenerates recordings/sample-ingest.json and recordings/sample-query.json
// from the mock pipeline, with realistic timing preserved in the `t` offsets.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../server/bus.js';
import { Recorder } from '../server/recorder.js';
import { MockPipeline } from '../server/pipeline/mock.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'recordings');
const bus = new EventBus();
const recorder = new Recorder(bus, { dir, autoCapture: false });
const pipeline = new MockPipeline(bus, { delayScale: Number(process.env.MOCK_DELAY_SCALE ?? 1) });

recorder.start('sample-ingest');
await pipeline.submitFact('DigitalOcean Spaces is S3-compatible object storage. Managed Postgres supports the pgvector extension for similarity search.');
await recorder.stop();

recorder.start('sample-query');
await pipeline.ask('Which DigitalOcean database supports similarity search?');
await recorder.stop();

for (const name of ['sample-ingest', 'sample-query']) {
  const rec = await recorder.load(name);
  rec.flow = name.replace('sample-', '');
  await recorder.save(rec);
}
console.log('Wrote', path.join(dir, 'sample-ingest.json'), 'and sample-query.json');
