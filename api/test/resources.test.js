import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

const API_URL = 'http://localhost:9926';

const TEST_IMAGE_PATH = path.join(import.meta.dirname, 'test-image.png');

async function uploadImage(filePath) {
	const imageData = await fsPromises.readFile(filePath);
	const res = await fetch(`${API_URL}/Images`, {
		method: 'POST',
		headers: { 'Content-Type': 'image/png' },
		body: imageData,
	});
	let errorBody;
	if (!res.ok) {
		try {
			errorBody = await res.text();
		} catch (e) {
			errorBody = '<failed to read body>';
		}
		console.error(`Failed to upload image: ${res.status} ${res.statusText}\nBody: ${errorBody}`);
		throw new Error(`Failed to upload image: ${res.status} ${res.statusText}`);
	}
	const json = await res.json();
	await new Promise(r => setTimeout(r, 150));
	assert.equal(res.status, 201);
	return json.id;
}

async function getVariantWithCacheHeader(imageId, width, dpr, format) {
	const cacheKey = `${imageId}_${width}_${dpr}_${format}`;
	const res = await fetch(`${API_URL}/ImageVariant/${cacheKey}`);
	if (res.status !== 200) {
		console.log('Variant error response:', res.status, await res.text());
	}
	assert.equal(res.status, 200);
	const xCache = res.headers.get('x-cache');
	const blob = await res.blob();
	return { blob, xCache };
}

describe('Image Optimizer API Integration', () => {
	let imageId;

	it('should upload an image and return an ID', async () => {
		imageId = await uploadImage(TEST_IMAGE_PATH);
		assert.ok(imageId);
	});

	it('should upload an image as a stream and return an ID', async () => {
		const imageDataStream = fs.createReadStream(TEST_IMAGE_PATH);
		const res = await fetch(`${API_URL}/Images`, {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: imageDataStream,
			duplex: 'half'
		});
		assert.equal(res.status, 201);
		const json = await res.json();
		assert.ok(json.id);
	});

	it('should generate and cache an image variant', async () => {
		const { blob: variantBlob1, xCache: xCache1 } = await getVariantWithCacheHeader(imageId, 300, 2, 'webp');
		const { blob: variantBlob2, xCache: xCache2 } = await getVariantWithCacheHeader(imageId, 300, 2, 'webp');
		assert.ok(variantBlob1.size > 0);
		assert.ok(variantBlob2.size > 0);
		assert.equal(variantBlob1.size, variantBlob2.size);
		assert.equal(xCache1, 'MISS');
		assert.equal(xCache2, 'HIT');
	});

	it('should upload an image with PUT and return 200', async () => {
		const id = 'test-image-1';
		const imageBuffer = await fsPromises.readFile(TEST_IMAGE_PATH);
		const res = await fetch(`${API_URL}/Images?id=${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: imageBuffer
		});
		assert.equal(res.status, 200);
		const json = await res.json();
		assert.ok(json?.data?.id === id || json?.id === id, 'Response missing id');
	});

	it('should return 400 for invalid image uploads', async () => {
		const res = await fetch(`${API_URL}/Images`, {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: Buffer.from('notanimage'),
		});
		assert.equal(res.status, 400);
		const json = await res.json();
		assert.ok(json);
	});

	it('should return 400 for missing parameters in image variant request', async () => {
		const res = await fetch(`${API_URL}/ImageVariant`);
		assert.equal(res.status, 400);
	});

	it('should return 404 for non-existent image variant', async () => {
		const res = await fetch(`${API_URL}/ImageVariant/nonexistent_300_2_webp`);
		assert.equal(res.status, 404);
	});
});
