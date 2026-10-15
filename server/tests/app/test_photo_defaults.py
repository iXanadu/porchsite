import base64

from server.app.image_add import NEXT, image_add
from server.app.photo_advice import PHOTO_ADVICE, photo_next

MB = 1024 * 1024


def test_adds_one_advice_line_with_identical_rounding_and_input_positions():
    assert photo_next(NEXT, [MB], False) == NEXT
    assert photo_next(NEXT, [MB + 1], False) == f"{NEXT}\nThis picture is 1.00 MB. {PHOTO_ADVICE}"
    assert photo_next(NEXT, [MB * 9 // 8], False) == f"{NEXT}\nThis picture is 1.13 MB. {PHOTO_ADVICE}"
    assert photo_next(NEXT, [24, MB * 9 // 8, MB * 9 // 8], True) == f"{NEXT}\nPictures over 1 MB: 2 (1.13 MB), 3 (1.13 MB). {PHOTO_ADVICE}"


async def test_image_response_fields_and_small_next_unchanged(db):
    def png(length):
        b = bytearray(length)
        b[:24] = bytes([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1])
        return base64.b64encode(b).decode()

    small = await image_add(db, "assistant:test", png(24))
    assert list(small) == ["image", "width", "height", "next"]
    assert small["next"] == NEXT
    large = png(MB + 1)
    result = await image_add(db, "assistant:test", images=[png(24), large, large])
    assert list(result) == ["images", "next"]
    assert len(result["images"]) == 3
    assert result["images"][1] == result["images"][2]
    assert result["next"] == f"{NEXT}\nPictures over 1 MB: 2 (1.00 MB), 3 (1.00 MB). {PHOTO_ADVICE}"
