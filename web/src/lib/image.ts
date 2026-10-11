// Photos are shrunk in the browser before upload (SPEC 5), so the free tier never
// pays for image processing and uploads stay small on mobile data.

interface Opts { maxEdge?: number; maxBytes?: number; jpeg?: boolean }

/** `jpeg` forces JPEG output (the vision model reads JPEG most reliably). */
export async function compressImage(file: Blob, { maxEdge = 1600, maxBytes = 5 * 1024 * 1024, jpeg = false }: Opts = {}): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a photo.');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('This photo format is not supported. Try a JPEG or PNG.');
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs would turn black as JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const toBlob = (type: string, q: number) => new Promise<Blob | null>(r => canvas.toBlob(r, type, q));
  for (const q of [0.82, 0.7, 0.55]) {
    const webp = jpeg ? null : await toBlob('image/webp', q);
    // Safari without WebP encoding falls back to PNG; use JPEG instead.
    const out = webp && webp.type === 'image/webp' ? webp : await toBlob('image/jpeg', q);
    if (out && out.size <= maxBytes) return out;
  }
  throw new Error('This photo is too large, even after shrinking it.');
}
