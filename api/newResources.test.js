describe('Image Optimizer API Integration', () => {
  beforeAll(() => {
    // Start HarperDB instance, set up test environment
    // Ensure tables exist (images, image_variants)
  });

  afterAll(() => {
    // Stop HarperDB, clean up resources
  });

  it('should upload an image and return an ID', async () => {
    // POST /Images with a valid image file
    // Expect: status 201, response contains image ID
  });

  it('should generate and cache an image variant', async () => {
    // GET /ImageVariant?id={imageId}_300_2_webp
    // Expect: status 200, response contains optimized image blob
  });

  it('should update an image and purge old variants', async () => {
    // PUT /Images?id=imageId with new image data
    // Expect: status 200, response contains updated image ID
    // GET /ImageVariant?id={imageId}_300_2_webp
    // Expect: new variant generated, old variant purged
  });

  it('should handle invalid uploads gracefully', async () => {
    // POST /Images with invalid data
    // Expect: status 400, error message
  });
});