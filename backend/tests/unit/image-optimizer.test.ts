import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { IMAGE_PROFILES, MAX_INPUT_PIXELS, needsCardThumbnail, optimizeImage } from '../../src/infra/storage/image-optimizer';

/** A noisy photo-like image — flat colours would compress to nothing and prove little. */
async function photo(width: number, height: number): Promise<sharp.Sharp> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      pixels[i] = (x * 7 + y * 3) % 256;
      pixels[i + 1] = (x * y) % 256;
      pixels[i + 2] = ((x ^ y) * 5 + ((x * 31 + y * 17) % 23)) % 256;
    }
  }
  return sharp(pixels, { raw: { width, height, channels } });
}

describe('optimizeImage', () => {
  it('converts a large JPEG to a smaller WebP inside the product box, keeping the aspect ratio', async () => {
    const input = await (await photo(2400, 1600)).jpeg({ quality: 95 }).toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.product);

    expect(result.contentType).toBe('image/webp');
    expect(result.inputFormat).toBe('jpeg');
    expect([result.width, result.height]).toEqual([1200, 800]);
    expect(result.data.byteLength).toBeLessThan(input.byteLength);
    const meta = await sharp(result.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1200, 800]);
  });

  it('converts a PNG and keeps its transparency', async () => {
    const input = await sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.category);

    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.hasAlpha).toBe(true);
    expect([result.width, result.height]).toEqual([600, 400]);
  });

  it('never enlarges a small image', async () => {
    const input = await (await photo(300, 200)).jpeg().toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.banner);

    expect([result.width, result.height]).toEqual([300, 200]);
  });

  it('keeps an already-compact WebP byte for byte instead of re-encoding it', async () => {
    const input = await (await photo(400, 400)).webp({ quality: 40 }).toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.product);

    expect(result.keptOriginal).toBe(true);
    expect(result.data.equals(input)).toBe(true);
  });

  it('resizes an oversized WebP', async () => {
    const input = await (await photo(1800, 1800)).webp({ quality: 90 }).toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.product);

    expect(result.keptOriginal).toBe(false);
    expect([result.width, result.height]).toEqual([1200, 1200]);
  });

  it('applies each profile box: thumb 480, profile 800, banner 1600', async () => {
    const input = await (await photo(2000, 1000)).jpeg().toBuffer();
    expect((await optimizeImage(input, IMAGE_PROFILES.productThumb)).width).toBe(480);
    expect((await optimizeImage(input, IMAGE_PROFILES.profile)).width).toBe(800);
    expect((await optimizeImage(input, IMAGE_PROFILES.banner)).width).toBe(1600);
  });

  it('auto-rotates from EXIF orientation and strips the metadata', async () => {
    // Stored 400x200 landscape, EXIF says "rotate 90°" -> upright 200x400.
    const input = await (await photo(400, 200)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.product);

    const meta = await sharp(result.data).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(meta.exif).toBeUndefined();
  });

  it('accepts AVIF input', async () => {
    const input = await (await photo(300, 300)).avif().toBuffer();
    const result = await optimizeImage(input, IMAGE_PROFILES.product);

    expect(result.inputFormat).toBe('avif');
    expect((await sharp(result.data).metadata()).format).toBe('webp');
  });

  it('rejects bytes that are not an image, whatever the client claimed', async () => {
    await expect(optimizeImage(Buffer.from('<html>definitely not a jpeg</html>'), IMAGE_PROFILES.product)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('rejects a truncated (corrupt) JPEG', async () => {
    const full = await (await photo(800, 800)).jpeg().toBuffer();
    await expect(optimizeImage(full.subarray(0, Math.floor(full.byteLength / 2)), IMAGE_PROFILES.product)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('rejects formats outside the upload allow-list (GIF)', async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    await expect(optimizeImage(gif, IMAGE_PROFILES.product)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('only asks for a card thumbnail when the image is well above card size', () => {
    expect(needsCardThumbnail(1200, 1200)).toBe(true);
    expect(needsCardThumbnail(1200, 400)).toBe(true);
    expect(needsCardThumbnail(720, 720)).toBe(false);
    expect(needsCardThumbnail(387, 516)).toBe(false);
  });

  it('rejects decompression bombs before decoding them', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1;
    const bomb = await sharp({ create: { width: side, height: side, channels: 3, background: '#808080' } })
      .jpeg({ quality: 10 })
      .toBuffer();
    await expect(optimizeImage(bomb, IMAGE_PROFILES.product)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
