import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingConfig, scoreFloor, cosineSearch, SCORE_FLOOR, LOCAL_SCORE_FLOOR, looksSpanish, dontKnowText, DONT_KNOW_TEXT, DONT_KNOW_TEXT_ES } from '../server/pipeline/retrieval.js';
import { LOCAL_DIM } from '../server/pipeline/embedding.js';

test('retrieval: embeddingConfig key falls back to HARNESS_INFERENCE_API_KEY; dim follows the model', () => {
  assert.equal(embeddingConfig({ DO_INFERENCE_KEY: 'model-key', HARNESS_INFERENCE_API_KEY: 'harness-key' }).key, 'model-key', 'DO_INFERENCE_KEY wins');
  assert.equal(embeddingConfig({ HARNESS_INFERENCE_API_KEY: 'harness-key' }).key, 'harness-key', 'falls back to the harness inference key');
  assert.equal(embeddingConfig({}).key, '');
  assert.equal(embeddingConfig({}).dim, LOCAL_DIM);
  assert.equal(embeddingConfig({ DO_EMBEDDING_MODEL: 'bge-m3' }).dim, 1024);
  assert.equal(embeddingConfig({ DO_EMBEDDING_MODEL: 'bge-m3', VECTOR_DIM: '768' }).dim, 768);
});

test('retrieval: the relevance floor follows the embedder (0.52 for a hosted model, 0.08 for the local hash)', () => {
  assert.equal(SCORE_FLOOR, 0.52);
  assert.equal(LOCAL_SCORE_FLOOR, 0.08);
  assert.equal(scoreFloor(embeddingConfig({})), LOCAL_SCORE_FLOOR);
  assert.equal(scoreFloor(embeddingConfig({ DO_EMBEDDING_MODEL: 'bge-m3' })), SCORE_FLOOR);
  assert.equal(scoreFloor(undefined), LOCAL_SCORE_FLOOR);
});

test('retrieval: cosineSearch filters with the floor it is given (default: local floor)', async () => {
  const rows = [
    { id: 1, chunk: 'match', object_key: 'facts/1.txt', score: 0.61 },
    { id: 2, chunk: 'bge noise', object_key: 'facts/2.txt', score: 0.41 },
    { id: 3, chunk: 'hash noise', object_key: null, score: 0.05 },
  ];
  const queryable = { query: async () => ({ rows }) };
  const qvec = [0.1, 0.2];
  assert.deepEqual((await cosineSearch(queryable, 't', qvec, 3)).map((h) => h.id), [1, 2], 'default = LOCAL_SCORE_FLOOR keeps the old behaviour');
  assert.deepEqual((await cosineSearch(queryable, 't', qvec, 3, LOCAL_SCORE_FLOOR)).map((h) => h.id), [1, 2]);
  assert.deepEqual((await cosineSearch(queryable, 't', qvec, 3, SCORE_FLOOR)).map((h) => h.id), [1], 'bge-m3 floor drops ~0.4 unrelated text');
  assert.deepEqual(await cosineSearch({ query: async () => ({ rows: [{ id: 9, chunk: 'x', score: 0.52 }] }) }, 't', qvec, 3, SCORE_FLOOR), [], 'the floor itself is not above the floor');
});

test('retrieval: Spanish heuristic picks the Spanish "don\'t know" line, English otherwise', () => {
  assert.equal(DONT_KNOW_TEXT, 'I do not know that yet.');
  assert.equal(DONT_KNOW_TEXT_ES, 'Todavía no lo sé.');
  const spanish = ['¿Dónde corre Acme?', 'Cuántos droplets tiene Acme', 'Cuantos droplets tiene Acme', 'Que es el pipeline', 'Dime donde corre Acme', '¡Hola!'];
  for (const q of spanish) {
    assert.ok(looksSpanish(q), `Spanish: ${q}`);
    assert.equal(dontKnowText(q), DONT_KNOW_TEXT_ES, q);
  }
  const english = ['Where does Acme run?', 'How many GPU droplets does Acme run in SFO3?', 'Tell me about the son of Al', 'What is La Salle known for?', ''];
  for (const q of english) {
    assert.ok(!looksSpanish(q), `English: ${q}`);
    assert.equal(dontKnowText(q), DONT_KNOW_TEXT, q);
  }
});
