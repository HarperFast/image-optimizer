import sharp from 'sharp';
import { Resource, databases, logger } from 'harperdb';
import { parseCacheKey, formatToContentType } from './utils/index.js';
import { User } from './types/index.js';

const ImagesTable = databases.ImageOptimization.images;
const VariantsTable = databases.ImageOptimization.image_variants;

export class ImageVariant extends Resource {
	static loadAsInstance = false;

	allowRead(user: User) {
		return user?.role?.id === 'super_user';
	}

	// Retrieve or generate an image variant using a cache key
	async get(target: any) {
		const rawId =
			(typeof target?.get === 'function' && target.get('id')) || (typeof target === 'string' ? target : target?.id);

		if (typeof rawId !== 'string') {
			logger.error('ImageVariant.get called with invalid id:', target);
			return { status: 400, data: { error: 'Invalid cache key: id must be a string' } };
		}

		const parsed = parseCacheKey(rawId);
		if (!parsed) {
			logger.warn('ImageVariant.get called with malformed cache key:', rawId);
			return {
				status: 400,
				data: {
					error: 'Malformed cache key. Expected `${imageId}_${width|orig}_${dpr}_{webp|jpeg|avif|png}`',
				},
			};
		}

		const { imageId, width, dpr, format, cacheKey } = parsed;
		logger.info('ImageVariant.get:', { cacheKey, imageId, width, dpr, format });

		// Cache lookup
		const cached = await VariantsTable.get(cacheKey);
		if (cached?.blob) {
			// Normalize blob type for response
			if (Buffer.isBuffer(cached.blob)) {
				cached.blob = createBlob(cached.blob);
			}
			return cached;
		}

		// Load original
		const image = await ImagesTable.get(imageId);
		if (!image?.blob) {
			return { status: 404, data: { error: 'Image not found' } };
		}

		let originalBuf: Buffer;
		if (image.blob instanceof Blob) {
			originalBuf = Buffer.from(await image.blob.arrayBuffer());
		} else if (Buffer.isBuffer(image.blob)) {
			originalBuf = image.blob;
		} else if ((image.blob as any)?.data) {
			originalBuf = Buffer.from((image.blob as any).data);
		} else {
			logger.error('Unsupported original image blob type for image:', imageId);
			return { status: 500, data: { error: 'Unsupported original image blob type' } };
		}

		// Generate variant
		let sharpInstance = sharp(originalBuf, { failOnError: false });

		if (width) {
			// Scale by DPR but avoid upscaling beyond original
			sharpInstance = sharpInstance.resize({
				width: Math.max(1, Math.floor(width * dpr)),
				withoutEnlargement: true,
			});
		}

		switch (format) {
			case 'webp':
				sharpInstance = sharpInstance.webp({ quality: 75 });
				break;
			case 'jpeg':
				sharpInstance = sharpInstance.jpeg({ quality: 80, mozjpeg: true });
				break;
			case 'avif':
				sharpInstance = sharpInstance.avif({ quality: 50 });
				break;
			case 'png':
				sharpInstance = sharpInstance.png();
				break;
		}

		let variantBuf: Buffer;
		try {
			variantBuf = await sharpInstance.toBuffer();
		} catch (err: any) {
			logger.error('Variant generation failed:', err);
			return { status: 500, data: { error: 'Variant generation failed: ' + err.message } };
		}

		const contentType = formatToContentType(format);
		const record = {
			imageId,
			format,
			width, // requested CSS px width (null = orig)
			dpr, // device pixel ratio
			blob: createBlob(variantBuf),
			contentType,
			bytes: variantBuf.length,
			createdAt: new Date().toISOString(),
		};

		// Persist in cache table
		try {
			await VariantsTable.put(record);
		} catch (err: any) {
			logger.error('Failed to persist image variant:', { cacheKey, err });
			// still return the fresh variant even if caching fails
		}

		return {
			status: 200,
			headers: { 'Content-Type': 'image/webp' },
			body: record.blob,
		};
	}
}

export class Images extends Resource {
	static loadAsInstance = false;

	allowRead(user: User) {
		return user?.role?.id === 'super_user';
	}

	// Upload and store original image
	async post(target: any, data: any) {
		let bytes: Buffer | Uint8Array;

		if (Buffer.isBuffer(data?.data)) {
			bytes = data.data;
		} else if (typeof data?.data?.arrayBuffer === 'function') {
			bytes = new Uint8Array(await data.data.arrayBuffer());
		} else if (data?.data) {
			bytes = new Uint8Array(data.data);
		} else {
			logger.error('No image data provided in POST request');
			return { status: 400, data: { error: 'No image data provided' } };
		}

		if (!bytes || bytes.length === 0) {
			logger.error('Empty image data');
			return { status: 400, data: { error: 'Empty image data' } };
		}

		// Validate image
		try {
			await sharp(bytes).metadata();
		} catch (err: any) {
			logger.error('Invalid image format:', err);
			return { status: 400, data: { error: 'Invalid image format: ' + err.message } };
		}

		const id = Math.random().toString(36).slice(2, 10);

		await ImagesTable.put({
			id,
			blob: createBlob(bytes),
			contentType: target?.headers?.['content-type'] || 'application/octet-stream',
			createdAt: new Date().toISOString(),
		});

		logger.info('Image stored with id:', id);
		return {
			status: 201,
			headers: { Location: `/images?id=${id}` },
			data: { id },
		};
	}

	// Upload or update original image with a specified id
	async put(target: any, data: any) {
		let bytes: Buffer | Uint8Array;

		if (Buffer.isBuffer(data?.data)) {
			bytes = data.data;
		} else if (typeof data?.data?.arrayBuffer === 'function') {
			bytes = new Uint8Array(await data.data.arrayBuffer());
		} else if (data?.data) {
			bytes = new Uint8Array(data.data);
		} else {
			logger.error('No image data provided in PUT request');
			return { status: 400, data: { error: 'No image data provided' } };
		}

		if (!bytes || bytes.length === 0) {
			logger.error('Empty image data');
			return { status: 400, data: { error: 'Empty image data' } };
		}

		// Validate image
		try {
			await sharp(bytes).metadata();
		} catch (err: any) {
			logger.error('Invalid image format:', err);
			return { status: 400, data: { error: 'Invalid image format: ' + err.message } };
		}

		// Respect request param first
		const id =
			(typeof target?.get === 'function' && target.get('id')) ||
			target?.data?.id ||
			target?.headers?.['x-image-id'] ||
			(data as any)?.id ||
			Math.random().toString(36).slice(2, 10);

		await ImagesTable.put({
			id,
			blob: createBlob(bytes),
			contentType: target?.headers?.['content-type'] || 'application/octet-stream',
			updatedAt: new Date().toISOString(),
		});

		// Purge existing variants for this image so cache can repopulate lazily
		try {
			const variants = await VariantsTable.query({ imageId: id });
			for (const variant of variants || []) {
				const vId = (variant as any)?.id ?? variant;
				if (typeof vId === 'string') {
					await VariantsTable.delete(vId);
				}
			}
		} catch (err: any) {
			logger.error('Failed to purge old variants for image:', { id, err });
		}

		logger.info('Image upserted with id:', id);
		return {
			status: 200,
			headers: { Location: `/images?id=${id}` },
			data: { id },
		};
	}
}

VariantsTable.sourcedFrom(Images);
