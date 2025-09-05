import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.createBlob = (bytes) => new Blob([bytes]);

import { databases } from 'harperdb';

const imagesStore = new Map();
const variantsStore = new Map();

const FakeImagesTable = {
  async get(id) { return imagesStore.get(id); },
  async create(obj) {
    const id = 'img_' + Math.random().toString(36).slice(2, 8);
    const rec = { id, ...obj };
    imagesStore.set(id, rec);
    return { id };
  },
  async put(obj) {
    const existing = imagesStore.get(obj.id) ?? {};
    imagesStore.set(obj.id, { ...existing, ...obj });
  },
};

const FakeVariantsTable = {
  async get(key) { return variantsStore.get(key); },
  async put(rec) {
    const key = `${rec.imageId}_${rec.width ?? 'orig'}_${rec.dpr ?? 1}_${rec.format ?? 'webp'}`;
    variantsStore.set(key, { id: key, ...rec });
  },
  async query({ imageId }) {
    return [...variantsStore.values()].filter((v) => v.imageId === imageId);
  },
  async delete(id) { variantsStore.delete(id); },
  sourcedFrom(/* Images */) { /* no-op for tests */ },
};

databases.ImageOptimization.images = FakeImagesTable;
databases.ImageOptimization.image_variants = FakeVariantsTable;

const { ImageVariant, Images } = await import('../dist/resources.js');
import { parseCacheKey } from '../dist/utils/index.js';

beforeEach(() => {
  imagesStore.clear();
  variantsStore.clear();
});

function tinyPng() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6360000002000154a24f990000000049454e44ae426082',
    'hex'
  );
}

test('ImageVariant.get returns cached variant as Blob', async () => {
  const key = 'abc_300_2_webp';
  variantsStore.set(key, { id: key, blob: Buffer.from('CACHED'), contentType: 'image/webp' });

  const iv = new ImageVariant();
  const res = await iv.get(key);

  assert.ok(res);
  assert.ok(res.blob instanceof Blob);
  const bytes = Buffer.from(new Uint8Array(await res.blob.arrayBuffer())).toString();
  assert.equal(bytes, 'CACHED');
});

test('ImageVariant.get generates and returns a webp on cache miss', async () => {
  const originalId = 'orig';
  imagesStore.set(originalId, { id: originalId, blob: createBlob(tinyPng()), contentType: 'image/png' });

  const key = `${originalId}_200_2_webp`;
  assert.ok(parseCacheKey(key));

  const iv = new ImageVariant();
  const res = await iv.get(key);

  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/webp');
  assert.ok(res.body instanceof Blob);

  const outBuf = Buffer.from(new Uint8Array(await res.body.arrayBuffer()));
  assert.ok(outBuf.length > 0);
});

test('ImageVariant.get rejects malformed cache key (400)', async () => {
  const iv = new ImageVariant();
  await assert.rejects(() => iv.get('bad-key'), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('ImageVariant.get 404 when original image is missing', async () => {
  const iv = new ImageVariant();
  await assert.rejects(() => iv.get('missing_300_1_webp'), (err) => {
    assert.equal(err.statusCode, 404);
    return true;
  });
});

for (const format of ['webp', 'jpeg', 'avif', 'png']) {
  test(`ImageVariant.get generates and returns a ${format} variant`, async () => {
    const originalId = `orig${format}`;
    imagesStore.set(originalId, { id: originalId, blob: createBlob(tinyPng()), contentType: 'image/png' });
    const key = `${originalId}_100_1_${format}`;
    const iv = new ImageVariant();
    const res = await iv.get(key);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], `image/${format}`);
    assert.ok(res.body instanceof Blob);
    const outBuf = Buffer.from(new Uint8Array(await res.body.arrayBuffer()));
    assert.ok(outBuf.length > 0);
  });
}

test('ImageVariant.get returns original size when width is null', async () => {
  const originalId = 'origsize';
  imagesStore.set(originalId, { id: originalId, blob: createBlob(tinyPng()), contentType: 'image/png' });
  const key = `${originalId}_orig_1_webp`;
  const iv = new ImageVariant();
  const res = await iv.get(key);
  assert.equal(res.status, 200);
  assert.ok(res.body instanceof Blob);
});

test('ImageVariant.get throws 400 for unsupported blob type', async () => {
  const originalId = 'badblob';
  imagesStore.set(originalId, { id: originalId, blob: { not: 'a blob' }, contentType: 'image/png' });
  const key = `${originalId}_100_1_webp`;
  const iv = new ImageVariant();
  await assert.rejects(() => iv.get(key), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('ImageVariant.get returns correct Content-Type for all formats', async () => {
  const originalId = 'ctimg';
  imagesStore.set(originalId, { id: originalId, blob: createBlob(tinyPng()), contentType: 'image/png' });
  for (const format of ['webp', 'jpeg', 'avif', 'png']) {
    const key = `${originalId}_100_1_${format}`;
    const iv = new ImageVariant();
    const res = await iv.get(key);
    assert.equal(res.headers['Content-Type'], `image/${format}`);
  }
});

test('ImageVariant.get populates cache after variant generation', async () => {
  const originalId = 'cachepop';
  imagesStore.set(originalId, { id: originalId, blob: createBlob(tinyPng()), contentType: 'image/png' });
  const key = `${originalId}_100_1_webp`;
  const iv = new ImageVariant();
  await iv.get(key);
  const cached = await variantsStore.get(key);
  assert.ok(cached);
  assert.ok(cached.blob instanceof Blob);
});

test('Images.post validates and stores original (201)', async () => {
  const api = new Images();
  const req = { headers: { 'content-type': 'image/png' } };
  const res = await api.post(req, { data: tinyPng() });

  assert.equal(res.status, 201);
  assert.ok(res.data?.id);

  const stored = await databases.ImageOptimization.images.get(res.data.id);

  let blob = stored?.blob;
  if (!(blob instanceof Blob)) {
    if (Buffer.isBuffer(blob)) blob = createBlob(blob);
    else if (blob?.data) blob = createBlob(Buffer.from(blob.data));
  }
  assert.ok(blob instanceof Blob);
});

test('Images.put updates existing image and purges variants', async () => {
  const api = new Images();
  const id = 'putimg';
  imagesStore.set(id, { id, blob: createBlob(tinyPng()), contentType: 'image/png' });
  variantsStore.set(`${id}_300_1_webp`, { id: `${id}_300_1_webp`, imageId: id, blob: createBlob(Buffer.from('old')), format: 'webp', width: 300, dpr: 1 });
  const req = { get: (k) => k === 'id' ? id : undefined, headers: { 'content-type': 'image/png' } };
  const res = await api.put(req, { data: tinyPng() });
  assert.equal(res.status, 200);
  assert.ok(res.data?.id === id);
  assert.equal(variantsStore.size, 0);
});

test('Images.put throws 400 for missing image data', async () => {
  const api = new Images();
  const req = { get: () => 'putimg', headers: { 'content-type': 'image/png' } };
  await assert.rejects(() => api.put(req, { data: null }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('Images.put throws 400 for missing image id', async () => {
  const api = new Images();
  const req = { headers: { 'content-type': 'image/png' } };
  await assert.rejects(() => api.put(req, { data: tinyPng() }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('Images.put throws 400 for invalid image format', async () => {
  const api = new Images();
  const req = { get: () => 'putimg', headers: { 'content-type': 'image/png' } };
  await assert.rejects(() => api.put(req, { data: Buffer.from('notanimage') }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('Images.put upserts new image if id does not exist', async () => {
  const api = new Images();
  const id = 'newputimg';
  const req = { get: (k) => k === 'id' ? id : undefined, headers: { 'content-type': 'image/png' } };
  const res = await api.put(req, { data: tinyPng() });
  assert.equal(res.status, 200);
  assert.ok(res.data?.id === id);
  const stored = await databases.ImageOptimization.images.get(id);
  assert.ok(stored);
});
