/**
 * Every pickable part of the scene: title + description for the inspector.
 * Machines group parts; `stats` are filled live by main.js.
 */
export const MACHINES = {
  client: {
    key: 'client',
    label: 'CLIENT',
    title: 'Client',
    stage: null,
    desc: 'Your app or terminal. The keypad posts a fact (POST /api/facts) or a question (POST /api/ask) to the API; the answer streams back along the long return track.',
    color: '#38e8ff',
  },
  spaces: {
    key: 'spaces',
    label: 'SPACES · OBJECT STORAGE',
    title: 'Spaces · Object Storage',
    stage: 'spaces',
    desc: 'S3-compatible object storage. Each submitted fact is PUT as a text object into a bucket; a drawer slides open, the glowing document slab is filed, and the object event triggers the next stage.',
    color: '#38e8ff',
  },
  functions: {
    key: 'functions',
    label: 'FUNCTIONS · CHUNK & EMBED',
    title: 'Functions · Chunk & Embed',
    stage: 'functions',
    desc: 'A serverless Function wakes on the object event. The gears mesh while it runs; the press cuts the document into chunks, then stamps each chunk into a 128-dimension embedding vector.',
    color: '#ffb347',
  },
  vectordb: {
    key: 'vectordb',
    label: 'VECTOR DB · PGVECTOR',
    title: 'Managed Postgres · pgvector',
    stage: 'vectordb',
    desc: 'Managed PostgreSQL with the pgvector extension. Every chunk is a glowing cube in one of twelve chambers (cube count = rows in the table). A question runs a cosine-similarity search: the scanner sweeps the enclosure and the nearest cubes flash.',
    color: '#4dff9a',
  },
  router: {
    key: 'router',
    label: 'KNOWLEDGE BASE / MANAGED AGENT',
    title: 'Knowledge Base / Managed Agent',
    stage: 'kb',
    desc: 'The GenAI Platform retrieval and orchestration layer. The Knowledge Base embeds the question and asks pgvector for the nearest chunks; the dial needle points at the chambers that were retrieved. The Managed Agent stacks that context into a grounded prompt and dispatches it to inference.',
    color: '#b77bff',
  },
  inference: {
    key: 'inference',
    label: 'INFERENCE · GPU',
    title: 'Serverless Inference · GPU',
    stage: 'inference',
    desc: 'An OpenAI-compatible endpoint serving open models on GPUs. The platters spin up, the arm seeks across the glowing track rings and every generated token leaves as a particle on the return track to the client.',
    color: '#ff6b8a',
  },
};

/** stage name from an SSE event -> machine key */
export const STAGE_MACHINE = { spaces: 'spaces', functions: 'functions', vectordb: 'vectordb', kb: 'router', agent: 'router', inference: 'inference' };

const P = (key, machine, title, desc) => ({ key, machine, title, desc, solids: [] });

export const PARTS = {
  board: P('board', null, 'Base board', 'Everything sits on one bevelled board. Tracks carry data between machines; labels are engraved beside each one.'),
  track: P('track', null, 'Data track', 'Parallel pipes at 90° and 45°. Each stream of particles is one job; the colour is the job’s colour so you can follow it through every machine.'),

  'client.keypad': P('client.keypad', 'client', 'Keypad', 'Nine round keys. They press down when a request is sent: a fact or a question leaves the client as a stream of particles.'),
  'client.screen': P('client.screen', 'client', 'Terminal screen', 'Shows the current request and the answer as its tokens arrive back from inference.'),
  'client.plinth': P('client.plinth', 'client', 'Client housing', 'The client machine: an app, a CLI, a browser. It only knows the API.'),

  'spaces.drawer': P('spaces.drawer', 'spaces', 'Object drawer', 'One drawer per bucket prefix. It slides open to receive the document object and closes once the PUT is durable.'),
  'spaces.body': P('spaces.body', 'spaces', 'Bucket cabinet', 'The Spaces bucket. Cheap, durable, S3-compatible; the natural landing zone for raw data.'),
  'spaces.lamp': P('spaces.lamp', 'spaces', 'Event trigger lamp', 'Flashes when the object is stored: the event that invokes the Function.'),
  'spaces.doc': P('spaces.doc', 'spaces', 'Document object', 'A stored fact, as a text object. Colour = the job that wrote it.'),

  'functions.gears': P('functions.gears', 'functions', 'Meshing gears', 'Turn while the Function runs; the drive for the press.'),
  'functions.press': P('functions.press', 'functions', 'Chunk & embed press', 'Slams down to cut the document into chunks, then once per chunk to stamp its embedding vector.'),
  'functions.anvil': P('functions.anvil', 'functions', 'Anvil', 'Where the document lands. Chunks appear here as small cubes before they leave for the vector store.'),
  'functions.base': P('functions.base', 'functions', 'Function runtime', 'Serverless: nothing runs until the Spaces event arrives, and it scales to zero afterwards.'),

  'vectordb.enclosure': P('vectordb.enclosure', 'vectordb', 'Vector enclosure', 'Glass case over twelve chambers. Each cube is one row: chunk text + embedding vector.'),
  'vectordb.chamber': P('vectordb.chamber', 'vectordb', 'Chamber', 'One of twelve chambers (rows fill them round-robin). The needle on the router points here when a cube in it is retrieved.'),
  'vectordb.scanner': P('vectordb.scanner', 'vectordb', 'Similarity scanner', 'Sweeps the enclosure during a cosine-similarity search (ORDER BY embedding <=> query LIMIT 3).'),
  'vectordb.plinth': P('vectordb.plinth', 'vectordb', 'Managed Postgres', 'The database engine. The readout shows the live row count.'),
  'vectordb.cube': P('vectordb.cube', 'vectordb', 'Vector row', 'One chunk and its 128-dim embedding. Flashes white when a search retrieves it.'),

  'router.dial': P('router.dial', 'router', 'Retrieval dial', 'Knowledge Base. The needle sweeps while searching and settles pointing at the chamber of each retrieved chunk.'),
  'router.needle': P('router.needle', 'router', 'Needle', 'Points physically at the retrieved chamber in the vector enclosure.'),
  'router.knob': P('router.knob', 'router', 'Embedding knob', 'Turns one notch when the question is embedded.'),
  'router.tray': P('router.tray', 'router', 'Prompt tray', 'Managed Agent. One slot lights per retrieved chunk; the prompt lamp comes on when the grounded prompt is ready.'),
  'router.base': P('router.base', 'router', 'GenAI Platform', 'Knowledge Base + Managed Agent share one housing: retrieval on the left, orchestration on the right.'),

  'inference.platters': P('inference.platters', 'inference', 'Platters', 'Spin while the model generates. Track rings light in the job colour as tokens stream.'),
  'inference.arm': P('inference.arm', 'inference', 'Actuator arm', 'Seeks to a different track for every token.'),
  'inference.fan': P('inference.fan', 'inference', 'GPU fan', 'Spins up with the load.'),
  'inference.heatsink': P('inference.heatsink', 'inference', 'Heatsink', 'Fins at the back of the engine.'),
  'inference.base': P('inference.base', 'inference', 'Inference endpoint', 'OpenAI-compatible /chat/completions with stream: true. Pay per token, scale to zero.'),
};

export const SAMPLE_FACTS = [
  'The Q3 launch event is in Austin on October 22nd and starts at 9am.',
  'Our support SLA promises a first response within 4 hours for business customers.',
  'The Paris office moved to 12 Rue de Rivoli in March 2026.',
  'Spaces buckets in region nyc3 replicate objects across three availability zones.',
  'The on-call rotation hands over every Monday at 10am Eastern.',
  'pgvector supports HNSW indexes for approximate nearest-neighbour search.',
  'The marketing newsletter goes out on the first Tuesday of each month.',
  'Serverless inference bills per million tokens with no idle cost.',
];

export const SAMPLE_QUESTIONS = [
  'When is the Q3 launch event?',
  'What is the support SLA first response time?',
  'Where is the Paris office?',
  'How are Spaces objects replicated in nyc3?',
  'When does the on-call rotation hand over?',
  'Which index does pgvector support?',
  'When does the newsletter go out?',
  'How is serverless inference billed?',
];
