"""Request-owned values visible to templates, omitted from metadata walks."""
class LazyValues(dict):
    def __init__(self, view, values=None):
        super().__init__(view)
        self._lazy_values = values or {}
        self._lazy_resolved = {}
        for key in self._lazy_values:
            self.pop(key, None)

    def __contains__(self, key):
        return key in self._lazy_values or super().__contains__(key)

    def __getitem__(self, key):
        if key in self._lazy_values:
            if key not in self._lazy_resolved:
                self._lazy_resolved[key] = self._lazy_values[key]()
            return self._lazy_resolved[key]
        return super().__getitem__(key)

    def get(self, key, default=None):
        return self[key] if key in self else default


def lazy_values(view, values):
    if not isinstance(view, LazyValues):
        return LazyValues(view, values)
    view._lazy_values = values
    view._lazy_resolved = {}
    for key in values:
        view.pop(key, None)
    return view


def copy_lazy_values(source, view):
    values = getattr(source, "_lazy_values", None)
    return lazy_values(view, values) if values else view
