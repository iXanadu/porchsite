"""Shared wording for assistant tools and successful oversized uploads."""

PHOTO_ADVICE = "Shrink pictures before sending: web size, about 2400 pixels on the long side, usually under 1 MB (JPEG or WebP). Sending the original is possible, but tell your person first, plainly: bigger files use more of the free plan's limits, make pages slower and take more storage."
MB = 1024 * 1024


def photo_next(base: str, sizes: list[int], batch: bool) -> str:
    big = []
    for index, size in enumerate(sizes):
        if size <= MB:
            continue
        hundredths = (size * 100 + MB // 2) // MB
        text = f"{hundredths // 100}.{hundredths % 100:02d} MB"
        big.append(f"{index + 1} ({text})" if batch else text)
    if not big:
        return base
    size_line = f"Pictures over 1 MB: {', '.join(big)}." if batch else f"This picture is {big[0]}."
    return f"{base}\n{size_line} {PHOTO_ADVICE}"
