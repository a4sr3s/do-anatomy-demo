/**
 * The six DigitalOcean components in the scene: positions (isometric layout
 * forms a U so packets visibly loop around), colours and explainers.
 */
export const NODES = {
  spaces: {
    label: 'Spaces',
    sub: 'Object storage',
    shape: 'bucket',
    pos: [-6, 0, 2.6],
    color: 0x39d0ff,
    blurb:
      'S3-compatible object storage. Every submitted fact is written here as a text object. Durable, cheap, and the natural landing zone for raw data before it enters the AI pipeline.',
    stage: 'Fact lands as an object; a trigger kicks off processing.',
  },
  functions: {
    label: 'Functions',
    sub: 'Chunk + embed',
    shape: 'gear',
    pos: [-2, 0, 2.6],
    color: 0xffb84d,
    blurb:
      'Serverless Functions run code on demand without managing servers. This one splits the fact into chunks and turns each chunk into an embedding vector. It spins while it works.',
    stage: 'Text is chunked, then each chunk becomes a 128-dim vector.',
  },
  vectordb: {
    label: 'Managed Postgres',
    sub: 'pgvector',
    shape: 'db',
    pos: [2, 0, 2.6],
    color: 0x3fe0a8,
    blurb:
      'Managed PostgreSQL with the pgvector extension stores embeddings next to the text and answers nearest-neighbour queries with a single SQL ORDER BY. The cylinder fills as vectors are inserted.',
    stage: 'Vectors are inserted; questions run cosine similarity search here.',
  },
  kb: {
    label: 'Knowledge Base',
    sub: 'Retrieval',
    shape: 'book',
    pos: [2, 0, -2.6],
    color: 0xb48bff,
    blurb:
      'The Knowledge Base is the retrieval layer of the GenAI Platform: it embeds the incoming question, searches the vector store, and assembles the most relevant chunks as grounded context.',
    stage: 'Question is embedded and matched against stored chunks.',
  },
  agent: {
    label: 'Managed Agent',
    sub: 'GenAI Platform',
    shape: 'agent',
    pos: [-2, 0, -2.6],
    color: 0x0080ff,
    blurb:
      'A Managed Agent orchestrates the conversation: it takes the retrieved context, applies instructions and guardrails, and builds the prompt that goes to the model. No servers, no prompt plumbing to host.',
    stage: 'Agent composes a grounded prompt from retrieved context.',
  },
  inference: {
    label: 'Serverless Inference',
    sub: 'OpenAI-compatible',
    shape: 'chip',
    pos: [-6, 0, -2.6],
    color: 0xff5d73,
    blurb:
      'Serverless Inference exposes open models like Llama behind an OpenAI-compatible endpoint. Pay per token, scale to zero, stream the answer back. The halo pulses as tokens arrive.',
    stage: 'Model generates the answer, streamed token by token.',
  },
};

export const EDGES = [
  ['spaces', 'functions'],
  ['functions', 'vectordb'],
  ['vectordb', 'kb'],
  ['kb', 'agent'],
  ['agent', 'inference'],
];

export const STAGE_NAMES = Object.keys(NODES);
