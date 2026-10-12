import { createApp } from './app.js';

const port = Number(process.env.PORT) || 8080;
const { app, pipeline } = await createApp();
app.listen(port, () => {
  console.log(`DO anatomy demo listening on http://localhost:${port}  (PIPELINE_MODE=${pipeline.mode})`);
});
