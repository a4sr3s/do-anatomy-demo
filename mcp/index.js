import { createMcpApp } from './server.js';

const env = process.env;
if (!env.MCP_AUTH_TOKEN && env.NODE_ENV !== 'test') {
  console.error('MCP_AUTH_TOKEN is not set: refusing to start an unauthenticated tool server');
  process.exit(1);
}
const port = Number(env.PORT) || 8081;
const { app } = createMcpApp({ env });
app.listen(port, () => {
  console.log(`anatomy-data MCP server listening on http://localhost:${port}/mcp  (tool events -> ${env.TOOL_EVENT_URL || 'disabled'})`);
});
