/** Shared wording for assistant tools and successful oversized uploads. */
export const PHOTO_ADVICE = "Shrink pictures before sending: web size, about 2400 pixels on the long side, usually under 1 MB (JPEG or WebP). Sending the original is possible, but tell your person first, plainly: bigger files use more of the free plan's limits, make pages slower and take more storage.";
const MB = 1024 * 1024;
export function photoNext(base: string, sizes: number[], batch: boolean): string {
  const big = sizes.flatMap((size, index) => {
    if (size <= MB) return [];
    const hundredths = Math.floor((size * 100 + MB / 2) / MB);
    const text = `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")} MB`;
    return [batch ? `${index + 1} (${text})` : text];
  });
  if (!big.length) return base;
  const sizeLine = batch ? `Pictures over 1 MB: ${big.join(", ")}.` : `This picture is ${big[0]}.`;
  return `${base}\n${sizeLine} ${PHOTO_ADVICE}`;
}
