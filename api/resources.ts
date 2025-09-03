import sharp from "sharp";
import { Resource, databases, logger } from "harperdb";
import { User } from "./types/index.js";

const ImagesTable = databases.ImageOptimization.images;
const VariantsTable = databases.ImageOptimization.image_variants;

export class Images extends Resource {
    allowRead(user: User) {
        return user?.role?.id === 'super_user';
    }

    // Upload and store original image 
    async post(target: any, data: any) {
        let bytes;

        if (Buffer.isBuffer(target.data)) {
            bytes = target.data;
        } else if (typeof target.data?.arrayBuffer === "function") {
            bytes = new Uint8Array(await target.data.arrayBuffer());
        } else if (target.data) {
            bytes = new Uint8Array(target.data);
        } else {
            logger.error("No image data provided in POST request");
            return { status: 400, data: { error: "No image data provided" } };
        }

        if (!bytes || bytes.length === 0) {
            logger.error("Empty image data");
            return { status: 400, data: { error: "Empty image data" } };
        }

        // Validate image format with sharp
        try {
            await sharp(bytes).metadata();
        } catch (err: any) {
            logger.error("Invalid image format:", err);
            return { status: 400, data: { error: "Invalid image format: " + err.message } };
        }

        const id = Math.random().toString(36).slice(2, 10);
        await ImagesTable.put({
            id,
            blob: bytes,
            contentType: target.headers?.["content-type"] || "application/octet-stream",
            createdAt: new Date().toISOString(),
        });

        logger.info("Image stored with id:", id);
        return {
            status: 201,
            headers: { Location: `/images?id=${id}` },
            data: { id },
        };
    }

    // Retrieve optimized image 
    async get(target: any) {
        try {
            const id = target.get('id');
            if (!id) {
                return { status: 400, data: { error: "Missing image id" } };
            }
            const width = parseInt(target.get('width')) || null;
            const dpr = parseFloat(target.get('dpr')) || 1;
            const format = target.get('format') || 'webp';

            // Generate a unique variant key
            const variantKey = `${id}_${width || 'orig'}_${dpr}_${format}`;

            // Try to get variant from database
            let variant = await VariantsTable.get(variantKey);
            if (!variant) {
                // Get original image
                const image = await ImagesTable.get(id);
                logger.info("Retrieved original image:", image);
                if (!image?.blob) {
                    return { status: 404, data: { error: "Image not found" } };
                }
                // Generate variant
                let sharpInstance = sharp(image.blob);
                if (width) sharpInstance = sharpInstance.resize({ width: width * dpr, withoutEnlargement: true });
                if (format === 'webp') sharpInstance = sharpInstance.webp({ quality: 75 });
                else if (format === 'jpeg') sharpInstance = sharpInstance.jpeg({ quality: 80 });
                else if (format === 'avif') sharpInstance = sharpInstance.avif({ quality: 50 });

                let variantBlob;
                try {
                    variantBlob = await sharpInstance.toBuffer();
                } catch (err: any) {
                    logger.error("Variant generation failed:", err);
                    return { status: 400, data: { error: "Variant generation failed: " + err.message } };
                }

                // Store variant
                try {
                    await VariantsTable.put({
                        id: variantKey,
                        imageId: id,
                        blob: variantBlob,
                        format,
                        width,
                        dpr,
                        createdAt: new Date().toISOString(),
                    });
                } catch (err: any) {
                    logger.error("Failed to store variant:", err);
                    // Continue to return the generated variant even if storing fails
                }
                variant = { blob: variantBlob, format };
            }

            return {
                status: 200,
                headers: { "Content-Type": `image/${variant.format}` },
                body: variant.blob,
            };
        } catch (err: any) {
            logger.error("Error in GET /images:", err);
            return { status: 500, data: { error: "Internal server error: " + err.message } };
        }
    }
}