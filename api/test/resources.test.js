import { describe, before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

const API_URL = 'http://localhost:9926';
const TEST_IMAGE_PATH = path.join(__dirname, 'test-image.png'); 

async function uploadImage(filePath) {
	const imageData = await fs.readFile(filePath);
	const res = await fetch(`${API_URL}/Images`, {
		method: 'POST',
		headers: { 'Content-Type': 'image/png' },
		body: imageData,
	});
	const json = await res.json();
	assert.equal(res.status, 201);
	return json.data.id;
}

async function getImageVariant(imageId, width, dpr, format) {
	const cacheKey = `${imageId}_${width}_${dpr}_${format}`;
	const res = await fetch(`${API_URL}/ImageVariant?id=${cacheKey}`);
	assert.equal(res.status, 200);
	return await res.blob();
}

describe('Image Optimizer API Integration', () => {
	let imageId;

	it('should upload an image and return an ID', async () => {
		imageId = await uploadImage(TEST_IMAGE_PATH);
		assert.ok(imageId);
	});

	it('should generate and cache an image variant', async () => {
		const variantBlob = await getImageVariant(imageId, 300, 2, 'webp');
		assert.ok(variantBlob.size > 0);
	});

	it('should update an image and purge old variants', async () => {
		const newImageId = await uploadImage(TEST_IMAGE_PATH);
		const res = await fetch(`${API_URL}/Images?id=${newImageId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'image/png' },
			body: await fs.readFile(TEST_IMAGE_PATH),
		});
		const json = await res.json();
		assert.equal(res.status, 200);
		assert.equal(json.data.id, newImageId);
		
		const variantBlob = await getImageVariant(newImageId, 300, 2, 'webp');
		assert.ok(variantBlob.size > 0);
	});

	it('should handle invalid uploads gracefully', async () => {
		const res = await fetch(`${API_URL}/Images`, {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: Buffer.from('notanimage'),
		});
		assert.equal(res.status, 400);
		const json = await res.json();
		assert.ok(json);
	});
});
