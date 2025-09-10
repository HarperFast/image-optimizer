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
	const json = await res.json();
	assert.equal(res.status, 201);
	return json.id;
}

async function getImageVariant(imageId, width, dpr, format) {
	const cacheKey = `${imageId}_${width}_${dpr}_${format}`;
	const res = await fetch(`${API_URL}/ImageVariant?id=${cacheKey}`);
	if (res.status !== 200) {
		console.log('Variant error response:', res.status, await res.text());
	}
	assert.equal(res.status, 200);
	return await res.blob();
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
		const variantBlob = await getImageVariant(imageId, 300, 2, 'webp');
		assert.ok(variantBlob.size > 0);
	});

	it('should return a cached variant on repeated requests', async () => {
		const variantBlob1 = await getImageVariant(imageId, 300, 2, 'webp');
		const variantBlob2 = await getImageVariant(imageId, 300, 2, 'webp');
		assert.ok(variantBlob1.size > 0);
		assert.ok(variantBlob2.size > 0);
		assert.equal(variantBlob1.size, variantBlob2.size);
	});

	it('should update an image and purge old variants', async () => {
		const newImageId = await uploadImage(TEST_IMAGE_PATH);
		const res = await fetch(`${API_URL}/Images?id=${newImageId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: await fsPromises.readFile(TEST_IMAGE_PATH),
		});
		const json = await res.json();
		assert.equal(res.status, 200);
		assert.equal(+json.id, newImageId);

		const variantBlob = await getImageVariant(newImageId, 300, 2, 'webp');
		assert.ok(variantBlob.size > 0);
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
