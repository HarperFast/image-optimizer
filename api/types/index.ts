export type VariantFormat = "webp" | "jpeg" | "avif" | "png";

export interface User {
	username: string;
	role: {
		id: string;
		role: string;
	};
}
