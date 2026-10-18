"""Formatted results owned by a single view/render, not the process."""
def date_memo():
    values = {}
    def formatted(timestamp, options, render, locale="en-US", zone="UTC"):
        key = (timestamp, locale, zone, tuple(sorted(options.items())))
        if key not in values:
            values[key] = render()
        return values[key]
    return formatted
