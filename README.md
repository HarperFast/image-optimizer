# Image Optimizer

This component provides a REST API for uploading and retrieving optimized images using Harper as the backend. Images are stored in their original format and can be dynamically resized and converted to modern formats (WebP, AVIF, JPEG) for efficient delivery to any device.

A website can use this API to improve performance and user experience:
- **Serve optimal formats**: Automatically delivers images in the best format for each browser/device.
- **Responsive images**: Dynamically resizes images to match the exact dimensions needed for any screen, reducing bandwidth and load times.
- **Variant caching**: Caches and reuses optimized variants, so images are processed only once per size/format.
- **Better Core Web Vitals**: Reduces page weight and speeds up rendering, especially for mobile and slow connections.

## How it works
+ Images are uploaded as binary data and validated for format and integrity using Sharp.
+ The original image is saved in the images table within the ImageOptimization database.
+ When a client requests an image (GET), the API checks if a matching variant (by width, device pixel ratio, and format) exists in the image_variants table.
+ If the variant exists, it is returned instantly. If not, the API generates the optimized variant, stores it for future use, and returns it to the client.

## Getting Started
`git clone https://github.com/HarperDB/image-optimizer.git
cd image-optimizer`

`npm run dev`

This assumes you have the Harper stack already [installed](https://docs.harperdb.io/docs/deployments/install-harper) globally.

## Endpoints
- **POST /Images**: Uploads and stores the original image (via file upload). Validates the image before saving.
- **GET /Images**: Retrieves an optimized image by ID. Accepts query parameters for width (`width`), device pixel ratio (`dpr`), and format (`format`). If a requested variant does not exist, it is generated and cached automatically.

## Usage
### Upload an image
Use curl or Postman to upload an image (with Basic Auth):
```sh
curl --data-binary @your-image.png \
	-H "Content-Type: image/png" \
	-u username:password \
	http://localhost:9926/images
```
Or in Postman:
- Set method to POST
- Set URL to `http://localhost:9926/images`
- In Body, select `binary` and choose your image file
- Set header `Content-Type: image/png` (or your image type)
- In Authorization tab, select "Basic Auth" and enter your HarperDB username and password

### Retrieve an image
Use curl or Postman to get an image by ID and request a specific variant (with Basic Auth):
```sh
curl -u username:password "http://localhost:9926/images?id=IMAGE_ID&width=400&dpr=2&format=webp"
```
Or in Postman:
- Set method to GET
- Set URL to `http://localhost:9926/images?id=IMAGE_ID&width=400&dpr=2&format=webp`
- In Authorization tab, select "Basic Auth" and enter your HarperDB username and password

## Configuration
- **Database**: `ImageOptimization`
- **Tables**: `images`, `image_variants`
- See `schema.graphql` for table definitions.
- See `config.yaml` for API and resource setup.

## File Overview
- `api/resources.ts`: Main API logic for image upload, optimization, and retrieval.
- `schema.graphql`: Database schema for images and variants.
- `config.yaml`: Application configuration.
