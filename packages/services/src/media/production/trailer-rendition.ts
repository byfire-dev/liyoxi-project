/** Use probed display dimensions: rotation has already been applied by the probe. */
export function trailerRendition(
  source: { displayWidth: number | null; displayHeight: number | null },
  quality: "sd" | "hd",
) {
  const width = source.displayWidth,
    height = source.displayHeight;
  if (
    width === null ||
    height === null ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    Math.min(width, height) < 720
  )
    return null;
  const short = quality === "sd" ? 480 : 720,
    long = quality === "sd" ? 854 : 1280,
    maxWidth = width > height ? long : short,
    maxHeight = width > height ? short : long,
    widthLimited = width * maxHeight >= height * maxWidth,
    numerator = widthLimited ? Math.min(width, maxWidth) : Math.min(height, maxHeight),
    denominator = widthLimited ? width : height,
    outputWidth = Math.floor((width * numerator) / (denominator * 2)) * 2,
    outputHeight = Math.floor((height * numerator) / (denominator * 2)) * 2;
  // CI requires each dimension to be at least 128px. Never stretch a thin source to fit it.
  if (Math.min(outputWidth, outputHeight) < 128) return null;
  return { version: 1 as const, width: outputWidth, height: outputHeight };
}
