import { VariantFormat } from 'api/types/index.js';

function assertFormat(format: string): asserts format is VariantFormat {
	if (!['webp', 'jpeg', 'avif', 'png'].includes(format)) {
		throw new Error('Invalid format');
	}
}

export function formatToContentType(fmt: VariantFormat) {
	return `image/${fmt}`;
}

export function parseCacheKey(rawId: string) {
	// `${imageId}_${width}_${dpr}_${format}`
	// width can be "orig" or a positive integer
	const parts = rawId.split('_');
	if (parts.length !== 4) return null;

	const [imageId, widthRaw, dprRaw, formatRaw] = parts;
	const format = formatRaw?.toLowerCase() as VariantFormat;

	if (!imageId || !/^[a-z0-9-]+$/i.test(imageId)) return null;

	try {
		assertFormat(format);
	} catch (err) {
		return null;
	}

	const width = widthRaw === 'orig' ? null : Number.parseInt(widthRaw ?? '', 10);
	if (widthRaw !== 'orig' && (!Number.isFinite(width!) || width! <= 0)) return null;

	const dpr = Number.parseFloat(dprRaw ?? '');
	if (!Number.isFinite(dpr) || dpr <= 0) return null;

	// Normalize values for a canonical key
	const canonicalDpr = Number.isInteger(dpr)
		? String(dpr)
		: String(dpr)
				.replace(/(\.\d*?)0+$/, '$1')
				.replace(/\.$/, '');
	const canonicalWidth = width === null ? 'orig' : String(width);
	const cacheKey = `${imageId}_${canonicalWidth}_${canonicalDpr}_${format}`;

	return { imageId, width, dpr, format, cacheKey };
}
