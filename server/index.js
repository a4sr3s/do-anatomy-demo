import { createApp } from './app.js';

const port = Number(process.env.PORT) || 8080;
const { app, pipeline } = await createApp();
app.listen(port, () => {
  console.log(`DO anatomy demo listening on http://localhost:${port}  (PIPELINE_MODE=${pipeline.mode})`);
  // Warm-up: find or create the Harness Runtime session in the background so the
  // first question on stage is not cold. Non-blocking; failures are only logged.
  if (typeof pipeline.warmUp === 'function') pipeline.warmUp().catch((err) => console.error('[warm-up] failed:', err.message));
  // Database preparation: create the table and run the embedding migration now (dimension
  // mismatch -> column recreated, NULL embeddings re-embedded). Only the web service does this;
  // the MCP server never changes the schema. Non-blocking; failures are only logged.
  if (typeof pipeline.prepareDb === 'function') pipeline.prepareDb().catch((err) => console.error('[migrate] failed:', err.message));
});
