/**
 * Integration tests for the image-optimizer Harper component.
 *
 * Covers:
 * - Image upload (POST /Images) and response shape
 * - Image variant generation and caching (GET /ImageVariant/<cacheKey>)
 * - Image update (PUT /Images) and variant cache purge
 * - Error handling: invalid uploads, malformed cache keys, missing images
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, '..');
const TEST_IMAGE_PATH = resolve(__dirname, 'test-image.png');

// harper's `exports` only exposes ".", so 'harper/dist/bin/harper.js' is not resolvable.
// Resolve the CLI from the exported main entry and pass it explicitly.
const require = createRequire(import.meta.url);
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

function authFetch(
	ctx: ContextWithHarper,
	path: string,
	init: RequestInit & { headers?: Record<string, string> } = {},
) {
	const { headers = {}, ...rest } = init;
	const creds = Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	return fetch(`${ctx.harper.httpURL}${path}`, {
		...rest,
		headers: { Authorization: `Basic ${creds}`, ...headers },
	});
}

async function uploadImage(ctx: ContextWithHarper, imagePath: string, contentType = 'image/png'): Promise<string> {
	const imageData = await readFile(imagePath);
	const res = await authFetch(ctx, '/Images', {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body: imageData,
	});
	strictEqual(res.status, 201, `Expected 201 on upload, got ${res.status}`);
	const json = (await res.json()) as { id?: string; data?: { id: string } };
	const id = json?.id ?? json?.data?.id;
	ok(id, 'Expected an image id in response');
	return id as string;
}

void suite('Image Optimizer — core upload and variant flow', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	void test('POST /Images returns 201 with an image id', async () => {
		const id = await uploadImage(ctx, TEST_IMAGE_PATH);
		ok(typeof id === 'string' && id.length > 0, 'image id should be a non-empty string');
	});

	// Ported from the old api/test/resources.test.js, which is no longer run in CI:
	// it drove a live Harper on localhost:9926 rather than the harness. This was the
	// one path it covered that the integration suite did not — a streamed request body
	// (fs.createReadStream + duplex: 'half'), which exercises Harper's chunked-upload
	// handling rather than the buffered path every other upload test takes.
	void test('POST /Images accepts a streamed request body', async () => {
		const { admin, httpURL } = ctx.harper;
		const creds = Buffer.from(`${admin.username}:${admin.password}`).toString('base64');
		const res = await fetch(`${httpURL}/Images`, {
			method: 'POST',
			headers: { 'Content-Type': 'image/png', Authorization: `Basic ${creds}` },
			body: Readable.toWeb(createReadStream(TEST_IMAGE_PATH)) as ReadableStream<Uint8Array>,
			duplex: 'half',
		} as RequestInit & { duplex: 'half' });
		strictEqual(res.status, 201, `Expected 201 for a streamed upload, got ${res.status}`);
		const json = (await res.json()) as { id?: string; data?: { id: string } };
		ok(json?.id ?? json?.data?.id, 'Expected an image id from the streamed upload');
	});

	void test('GET /ImageVariant generates variant on MISS and returns image bytes', async () => {
		const imageId = await uploadImage(ctx, TEST_IMAGE_PATH);
		const cacheKey = `${imageId}_300_2_webp`;
		const res = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(res.status, 200, `Unexpected status ${res.status}`);
		strictEqual(res.headers.get('content-type'), 'image/webp', 'Expected webp content-type');
		const buf = await res.arrayBuffer();
		ok(buf.byteLength > 0, 'Variant response body should not be empty');
		const xCache = res.headers.get('x-cache');
		strictEqual(xCache, 'MISS', 'First variant request should be a cache MISS');
	});

	void test('GET /ImageVariant returns HIT on second request', async () => {
		const imageId = await uploadImage(ctx, TEST_IMAGE_PATH);
		const cacheKey = `${imageId}_300_2_webp`;

		// First request — MISS, stores variant
		const res1 = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(res1.status, 200);
		await res1.arrayBuffer(); // drain

		// Second request — should hit the cache
		const res2 = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(res2.status, 200);
		strictEqual(res2.headers.get('x-cache'), 'HIT', 'Second variant request should be a cache HIT');
		const buf2 = await res2.arrayBuffer();
		ok(buf2.byteLength > 0, 'Cached variant should have non-empty body');
	});

	void test('GET /ImageVariant supports avif and jpeg formats', async () => {
		const imageId = await uploadImage(ctx, TEST_IMAGE_PATH);

		for (const fmt of ['avif', 'jpeg'] as const) {
			const cacheKey = `${imageId}_200_1_${fmt}`;
			const res = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
			strictEqual(res.status, 200, `Expected 200 for ${fmt} variant`);
			strictEqual(res.headers.get('content-type'), `image/${fmt}`, `Wrong content-type for ${fmt}`);
			const buf = await res.arrayBuffer();
			ok(buf.byteLength > 0, `${fmt} variant should have non-empty body`);
		}
	});

	void test('GET /ImageVariant with orig width returns full-size image', async () => {
		const imageId = await uploadImage(ctx, TEST_IMAGE_PATH);
		const cacheKey = `${imageId}_orig_1_webp`;
		const res = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(res.status, 200);
		const buf = await res.arrayBuffer();
		ok(buf.byteLength > 0, 'orig variant should have non-empty body');
	});

	void test('PUT /Images replaces image and purges variant cache', async () => {
		// Upload original
		const id = 'put-test-image';
		const imageData = await readFile(TEST_IMAGE_PATH);

		const putRes = await authFetch(ctx, `/Images?id=${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: imageData,
		});
		strictEqual(putRes.status, 200, `PUT /Images expected 200, got ${putRes.status}`);
		const putJson = (await putRes.json()) as { id?: string; data?: { id: string } };
		const returnedId = putJson?.id ?? putJson?.data?.id;
		ok(returnedId === id, `Expected returned id "${id}", got "${returnedId}"`);

		// Generate a variant to populate the cache
		const cacheKey = `${id}_100_1_webp`;
		const variantRes = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(variantRes.status, 200);
		strictEqual(variantRes.headers.get('x-cache'), 'MISS');
		await variantRes.arrayBuffer();

		// Update the image — variants should be purged
		const putRes2 = await authFetch(ctx, `/Images?id=${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: imageData,
		});
		strictEqual(putRes2.status, 200, `Second PUT expected 200, got ${putRes2.status}`);
		await putRes2.arrayBuffer();

		// After PUT, the variant should be regenerated (MISS again)
		const variantRes2 = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(variantRes2.status, 200);
		const xCache2 = variantRes2.headers.get('x-cache');
		// The cache was invalidated by the PUT, so we expect a MISS on re-fetch
		strictEqual(xCache2, 'MISS', 'Variant should be regenerated (MISS) after PUT replaces the image');
		await variantRes2.arrayBuffer();
	});
});

void suite('Image Optimizer — error handling', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	void test('POST /Images with invalid image data returns 400', async () => {
		const res = await authFetch(ctx, '/Images', {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: Buffer.from('this is not an image'),
		});
		strictEqual(res.status, 400, `Expected 400 for invalid image, got ${res.status}`);
	});

	void test('POST /Images with empty body returns 400', async () => {
		const res = await authFetch(ctx, '/Images', {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: new Uint8Array(0),
		});
		strictEqual(res.status, 400, `Expected 400 for empty body, got ${res.status}`);
	});

	void test('GET /ImageVariant with malformed cache key returns 400', async () => {
		const res = await authFetch(ctx, '/ImageVariant/notacachekey');
		strictEqual(res.status, 400, `Expected 400 for malformed cache key, got ${res.status}`);
	});

	void test('GET /ImageVariant for non-existent image returns 404', async () => {
		const cacheKey = 'nonexistent-uuid_300_2_webp';
		const res = await authFetch(ctx, `/ImageVariant/${cacheKey}`);
		strictEqual(res.status, 404, `Expected 404 for missing image, got ${res.status}`);
	});

	void test('PUT /Images with invalid image data returns 400', async () => {
		const res = await authFetch(ctx, '/Images?id=invalid-test', {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: Buffer.from('not an image'),
		});
		strictEqual(res.status, 400, `Expected 400 for invalid PUT image, got ${res.status}`);
	});
});
