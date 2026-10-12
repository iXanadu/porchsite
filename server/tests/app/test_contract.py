"""What the server edition takes from the Cloudflare edition as data stays
in step with the server edition's own models."""

from server.app.fields import field_guide, kind_guide
from server.spec.models import MODELS


def test_the_field_guide_names_every_field_and_no_other():
    guide = field_guide()
    assert set(guide) == set(MODELS) == set(kind_guide())
    for kind, model in MODELS.items():
        assert set(guide[kind]) == set(model.model_fields), kind
        assert list(guide[kind]) == list(model.model_fields), kind
