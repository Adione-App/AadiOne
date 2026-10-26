import sharp, { type Color } from 'sharp';
import { describe, expect, it } from 'vitest';

import { cardFrame, IMAGE_PROFILES, MAX_INPUT_PIXELS, needsCardThumbnail, optimizeImage } from '../../src/infra/storage/image-optimizer';

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

/** A `size`×`size` product (the noisy photo) at (left, top) on a plain canvas. */
async function packshot(
  canvas: { width: number; height: number; background: Color; channels?: 3 | 4 },
  product: { left: number; top: number; size: number },
): Promise<Buffer> {
  const item = await (await photo(product.size, product.size)).png().toBuffer();
  return sharp({ create: { width: canvas.width, height: canvas.height, channels: canvas.channels ?? 3, background: canvas.background } })
    .composite([{ input: item, left: product.left, top: product.top }])
    .png()
    .toBuffer();
}

describe('cardFrame', () => {
  it('frames a product sitting in lots of white space, with an even margin', async () => {
    const input = await packshot({ width: 800, height: 800, background: '#ffffff' }, { left: 300, top: 300, size: 200 });
    const frame = await cardFrame(input);

    expect(frame).not.toBeNull();
    // The product (300–500) plus an ~8% margin, on every side.
    expect(frame!.left * 800).toBeGreaterThan(270);
    expect(frame!.left * 800).toBeLessThan(300);
    expect((frame!.left + frame!.width) * 800).toBeGreaterThan(500);
    expect((frame!.left + frame!.width) * 800).toBeLessThan(530);
    expect(frame!.height).toBeCloseTo(frame!.width, 1);

    const card = await optimizeImage(input, IMAGE_PROFILES.productThumb, frame);
    expect(card.width).toBeGreaterThan(200);
    expect(card.width).toBeLessThan(250);
  });

  it('keeps a coloured background colour (crops it, never removes it)', async () => {
    const cream = { r: 242, g: 234, b: 225 };
    const input = await packshot({ width: 600, height: 700, background: cream }, { left: 150, top: 200, size: 300 });
    const frame = await cardFrame(input);
    expect(frame).not.toBeNull();

    const card = await optimizeImage(input, IMAGE_PROFILES.productThumb, frame);
    const corner = await sharp(card.data).extract({ left: 1, top: 1, width: 1, height: 1 }).raw().toBuffer();
    expect(Math.abs((corner[0] ?? 0) - cream.r)).toBeLessThan(6);
    expect(Math.abs((corner[1] ?? 0) - cream.g)).toBeLessThan(6);
    expect(Math.abs((corner[2] ?? 0) - cream.b)).toBeLessThan(6);
  });

  it('frames a transparent packshot and keeps its transparency', async () => {
    const input = await packshot(
      { width: 700, height: 700, background: { r: 0, g: 0, b: 0, alpha: 0 }, channels: 4 },
      { left: 100, top: 250, size: 250 },
    );
    const frame = await cardFrame(input);
    expect(frame).not.toBeNull();

    const card = await optimizeImage(input, IMAGE_PROFILES.productThumb, frame);
    expect((await sharp(card.data).metadata()).hasAlpha).toBe(true);
  });

  it('keeps the white parts of a transparent product inside the frame', async () => {
    // A white "cap" (60px tall) above a coloured body, on transparency: over
    // white the cap vanishes, so it must be found over black as well.
    const cap = await sharp({ create: { width: 120, height: 60, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const body = await (await photo(120, 200)).png().toBuffer();
    const input = await sharp({ create: { width: 700, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: cap, left: 290, top: 200 },
        { input: body, left: 290, top: 260 },
      ])
      .png()
      .toBuffer();
    const frame = await cardFrame(input);
    expect(frame).not.toBeNull();
    expect(frame!.top * 700).toBeLessThan(200);
  });

  it('keeps a faint package outline on white inside the frame', async () => {
    // A light-grey pack (outline 18 levels below white) with a small print in its middle.
    const pack = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 237, g: 237, b: 237 } } })
      .composite([{ input: await (await photo(80, 80)).png().toBuffer(), left: 110, top: 160 }])
      .png()
      .toBuffer();
    const input = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#ffffff' } })
      .composite([{ input: pack, left: 250, top: 200 }])
      .jpeg({ quality: 90 })
      .toBuffer();
    const frame = await cardFrame(input);
    expect(frame).not.toBeNull();
    expect(frame!.left * 800).toBeLessThan(250);
    expect(frame!.top * 800).toBeLessThan(200);
    expect((frame!.left + frame!.width) * 800).toBeGreaterThan(550);
    expect((frame!.top + frame!.height) * 800).toBeGreaterThan(600);
  });

  it('leaves photos without a plain background alone (lifestyle shots)', async () => {
    const input = await (await photo(800, 800)).jpeg().toBuffer();
    expect(await cardFrame(input)).toBeNull();
  });

  it('leaves an already tightly framed packshot alone', async () => {
    const input = await packshot({ width: 500, height: 500, background: '#ffffff' }, { left: 15, top: 15, size: 470 });
    expect(await cardFrame(input)).toBeNull();
  });

  it('never frames a small photo down to a blurry crop', async () => {
    const input = await packshot({ width: 300, height: 300, background: '#ffffff' }, { left: 120, top: 120, size: 60 });
    expect(await cardFrame(input)).toBeNull();
  });

  it('frames the upright image of an EXIF-rotated photo', async () => {
    // Stored 800x400 with the product on the left; orientation 6 makes it 400x800, product at the top.
    const stored = await sharp(await packshot({ width: 800, height: 400, background: '#ffffff' }, { left: 50, top: 100, size: 200 }))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const frame = await cardFrame(stored);
    expect(frame).not.toBeNull();
    expect(frame!.top + frame!.height).toBeLessThan(0.5);

    const card = await optimizeImage(stored, IMAGE_PROFILES.productThumb, frame);
    expect(Math.abs(card.width - card.height)).toBeLessThan(12);
  });

  it('never keeps the uncropped original bytes when framing', async () => {
    const input = await sharp(await packshot({ width: 480, height: 480, background: '#ffffff' }, { left: 110, top: 110, size: 260 }))
      .webp({ quality: 40 })
      .toBuffer();
    const card = await optimizeImage(input, IMAGE_PROFILES.productThumb, await cardFrame(input));
    expect(card.keptOriginal).toBe(false);
    expect(card.width).toBeLessThan(480);
  });
});
