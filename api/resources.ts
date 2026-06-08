import sharp from 'sharp';
import { Resource, databases, logger, createBlob } from 'harper';
import { parseCacheKey, formatToContentType } from './utils/index.js';
import type { User } from './types/index.js';
import { randomUUID } from 'crypto';

const ImagesTable = databases.ImageOptimization.Image;
const VariantsTable = databases.ImageOptimization.ImageVariant;

export class ImageVariant extends Resource {
	static loadAsInstance = false;

	allowRead() {
		return true;
	}

	// Retrieve or generate an image variant using a cache key
	async get(target: any) {
		const rawId =
			(typeof target?.get === 'function' && target.get('id')) || (typeof target === 'string' ? target : target?.id);

		if (typeof rawId !== 'string') {
			logger.error('ImageVariant.get called with invalid id:', target);
			const err: any = new Error('Missing image id');
			err.statusCode = 400;
			throw err;
		}

		const parsed = parseCacheKey(rawId);

		if (!parsed) {
			logger.warn('ImageVariant.get called with malformed cache key:', rawId);
			const err: any = new Error(
				'Malformed cache key, expected `${imageId}_${width|orig}_${dpr}_{webp|jpeg|avif|png}`'
			);
			err.statusCode = 400;
			throw err;
		}

		const { imageId, width, dpr, format, cacheKey } = parsed;

		// Cache lookup
		let cached;
		try {
			cached = await VariantsTable.get(cacheKey);
		} catch (err) {
			logger.error('VariantsTable.get failed:', err);
			throw err;
		}
		if (cached?.blob) {
			if (Buffer.isBuffer(cached.blob)) {
				cached.blob = createBlob(cached.blob);
			}
			return {
				status: 200,
				headers: {
					'Content-Type': formatToContentType(format),
					'X-Cache': 'HIT',
				},
				body: cached.blob,
			};
		}

		// Yield to event loop after cache miss
		await new Promise((resolve) => setImmediate(resolve));

		// Load original
		let image;
		try {
			image = await ImagesTable.get(imageId);
		} catch (err) {
			logger.error('ImagesTable.get failed:', err);
			throw err;
		}
		if (!image?.blob) {
			logger.error('Image not found for imageId:', imageId);
			const err: any = new Error('Image not found');
			err.statusCode = 404;
			throw err;
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
			const err: any = new Error('Unsupported original image blob type');
			err.statusCode = 400;
			throw err;
		}

		// Generate variant
		let sharpInstance = sharp(originalBuf, { failOnError: false });

		if (width) {
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

		// Yield to event loop before heavy buffer operation
		await new Promise((resolve) => setImmediate(resolve));

		let variantBuf: Buffer;
		try {
			variantBuf = await sharpInstance.toBuffer();
		} catch (err: any) {
			logger.error('Variant generation failed:', err);
			err.statusCode = 500;
			throw err;
		}

		const contentType = formatToContentType(format);

		const record = {
			id: cacheKey,
			imageId: imageId,
			format: format,
			width: width,
			dpr: dpr,
			blob: createBlob(variantBuf),
			contentType: contentType,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		try {
			await VariantsTable.put(record);
		} catch (err: any) {
			logger.error('Failed to persist image variant:', { cacheKey, err, record });
		}

		return {
			status: 200,
			headers: {
				'Content-Type': formatToContentType(format),
				'X-Cache': 'MISS',
			},
			body: record.blob,
		};
	}
}

export class Images extends Resource {
	static loadAsInstance = false;

	allowRead(user: User, target?: any) {
		// allow public reads when the :id is a cache key (variant fetch)
		const rawId = (typeof target?.get === 'function' && target.get('id')) || target?.id;

		if (typeof rawId === 'string' && parseCacheKey(rawId)) return true;
		return user?.role?.id === 'super_user';
	}

	async get(target: any) {
		const rawId =
			(typeof target?.get === 'function' && target.get('id')) ||
			target?.id ||
			target?.query?.id ||
			target?.data?.id ||
			target?.headers?.['x-image-id'];

		if (typeof rawId === 'string' && parseCacheKey(rawId)) {
			const variants = new ImageVariant();
			return variants.get(target); // generates/serves cached variant
		}

		const image = await ImagesTable.get(rawId);
		if (!image?.blob) {
			logger.error('Image not found for id:', rawId);
			const err: any = new Error('Image not found');
			err.statusCode = 404;
			throw err;
		}
		return {
			status: 200,
			headers: {
				'Content-Type': image.contentType || 'application/octet-stream',
			},
			body: image.blob,
		};
	}

	// Upload and store original image
	async post(target: any, data: any) {
		let bytes: Buffer | Uint8Array | undefined = undefined;

		if (Buffer.isBuffer(data?.data)) {
			bytes = data.data;
		} else if (typeof data?.data?.arrayBuffer === 'function') {
			bytes = new Uint8Array(await data.data.arrayBuffer());
		} else if (data?.data) {
			bytes = new Uint8Array(data.data);
		}

		if (!bytes || bytes.length === 0) {
			const err: any = new Error('Empty image data');
			err.statusCode = 400;
			throw err;
		}

		// Validate image
		try {
			await sharp(bytes).metadata();
		} catch (err: any) {
			logger.error('Invalid image format:', err);
			err.statusCode = 400;
			throw err;
		}

		const newResource = await ImagesTable.create({
			id: randomUUID(),
			blob: createBlob(bytes),
			contentType: target?.headers?.['content-type'] || 'application/octet-stream',
			createdAt: new Date().toISOString(),
		});

		logger.info('Image stored with id:', newResource.id);
		return {
			status: 201,
			headers: { Location: `/images?id=${newResource.id}` },
			data: { id: newResource.id },
		};
	}

	// Upload or update original image with a specified id
	async put(target: any, data: any) {
		const id =
			(typeof target?.get === 'function' && target.get('id')) ||
			target?.id ||
			target?.query?.id ||
			target?.data?.id ||
			target?.headers?.['x-image-id'] ||
			(data as any)?.id;

		let bytes: Buffer | Uint8Array;
		if (Buffer.isBuffer(data?.data)) {
			bytes = data.data;
		} else if (typeof data?.data?.arrayBuffer === 'function') {
			bytes = new Uint8Array(await data.data.arrayBuffer());
		} else if (data?.data) {
			bytes = new Uint8Array(data.data);
		} else {
			logger.error('No image data provided in PUT request');
			const err: any = new Error('No image data provided in PUT request');
			err.statusCode = 400;
			throw err;
		}
		if (!bytes || bytes.length === 0) {
			logger.error('Empty image data');
			const err: any = new Error('Empty image data');
			err.statusCode = 400;
			throw err;
		}

		// Validate image
		try {
			await sharp(bytes).metadata();
		} catch (err: any) {
			logger.error('Invalid image format:', err);
			err.statusCode = 400;
			throw err;
		}

		const putObj = {
			id,
			blob: createBlob(bytes),
			contentType: target?.headers?.['content-type'] || 'application/octet-stream',
			updatedAt: new Date().toISOString(),
		};

		try {
			await ImagesTable.put(putObj);
		} catch (err) {
			logger.error('Images.put: ImagesTable.put failed:', err);
			throw err;
		}

		// Purge existing variants for this image so cache can repopulate lazily
		try {
			const variants = await VariantsTable.query({ imageId: id });
			for (const variant of variants || []) {
				const vId = (variant as any)?.id ?? variant;
				if (typeof vId === 'string') {
					await VariantsTable.invalidate(vId);
				}
			}
		} catch (err: any) {
			logger.error('Failed to purge old variants for image:', { id, err });
		}

		return {
			status: 200,
			headers: { Location: `/images?id=${id}` },
			data: { id },
		};
	}
}

// VariantsTable variant generation is handled manually in ImageVariant.get();
// sourcedFrom is not used here because variant IDs differ from image IDs.
