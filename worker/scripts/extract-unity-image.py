"""Extract one Sprite/Texture2D image from a Hololive Dreams Unity bundle.

The Octo distribution normally returns a UnityFS bundle.  Older or protected
responses can have the first 256 bytes masked with the short bundle-name key;
the small decryptor below mirrors the game's public asset-tool format.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


def bundle_mask(name: str) -> bytes:
    raw = bytearray(2 * len(name))
    for index, character in enumerate(name):
        value = ord(character) & 0xFF
        raw[2 * index] = value
        raw[2 * len(name) - 1 - 2 * index] = (~value) & 0xFF
    rotate = 0x7C
    for index, value in enumerate(raw):
        rotate = ((((rotate & 1) << 7) | (rotate >> 1)) ^ value) & 0xFF
    return bytes(value ^ rotate for value in raw)


def unmask(data: bytes, name: str) -> bytes:
    if data.startswith(b"UnityFS") or len(data) < 256 or not name:
        return data
    mask = bundle_mask(name)
    header = bytes(value ^ mask[index % len(mask)] for index, value in enumerate(data[:256]))
    return header + data[256:]


def sprite_image(data):
    """Return a Sprite image while honoring a downscaled SpriteAtlas.

    UnityPy currently crops atlas coordinates at their authored size even when
    ``downscaleMultiplier`` points at a half-size runtime texture.  Hololive
    Dreams' CommonIconAtlas uses exactly that layout, which otherwise crops a
    neighboring icon (or an empty area) instead of the requested Sprite.
    """
    atlas_pointer = getattr(data, "m_SpriteAtlas", None)
    if not atlas_pointer or not getattr(atlas_pointer, "path_id", 0):
        return data.image

    atlas = atlas_pointer.read()
    atlas_data = next(
        (value for key, value in atlas.m_RenderDataMap if key == data.m_RenderDataKey),
        None,
    )
    if atlas_data is None:
        return data.image

    scale = float(getattr(atlas_data, "downscaleMultiplier", 1.0) or 1.0)
    if abs(scale - 1.0) < 1e-6:
        return data.image

    from PIL import Image, ImageDraw  # pylint: disable=import-outside-toplevel
    from PIL.Image import Transpose  # pylint: disable=import-outside-toplevel
    from UnityPy.enums import (  # pylint: disable=import-outside-toplevel
        SpritePackingMode,
        SpritePackingRotation,
    )
    from UnityPy.export.SpriteHelper import (  # pylint: disable=import-outside-toplevel
        SpriteSettings,
        get_image,
    )
    from UnityPy.helpers.MeshHelper import MeshHandler  # pylint: disable=import-outside-toplevel

    source = get_image(data, atlas_data.texture, atlas_data.alphaTexture)
    rect = atlas_data.textureRect
    left = math.floor(rect.x * scale)
    top = math.floor(rect.y * scale)
    right = math.ceil((rect.x + rect.width) * scale)
    bottom = math.ceil((rect.y + rect.height) * scale)
    image = source.crop((left, top, right, bottom))

    settings = SpriteSettings(atlas_data.settingsRaw)
    if settings.packed:
        rotation = settings.packingRotation
        if rotation == SpritePackingRotation.kSPRFlipHorizontal:
            image = image.transpose(Transpose.FLIP_LEFT_RIGHT)
        elif rotation == SpritePackingRotation.kSPRFlipVertical:
            image = image.transpose(Transpose.FLIP_TOP_BOTTOM)
        elif rotation == SpritePackingRotation.kSPRRotate180:
            image = image.transpose(Transpose.ROTATE_180)
        elif rotation == SpritePackingRotation.kSPRRotate90:
            image = image.transpose(Transpose.ROTATE_270)

    if settings.packingMode == SpritePackingMode.kSPMTight:
        mesh = MeshHandler(data.m_RD, data.object_reader.version)
        mesh.process()
        positions = mesh.m_Vertices or []
        if positions:
            min_x = min(x for x, _y, _z in positions)
            min_y = min(y for _x, y, _z in positions)
            factor = data.m_PixelsToUnits * scale
            points = [((x - min_x) * factor, (y - min_y) * factor) for x, y, _z in positions]
            mask = Image.new("1", image.size, color=0)
            draw = ImageDraw.Draw(mask)
            for submesh in mesh.get_triangles():
                for a, b, c in submesh:
                    draw.polygon((points[a], points[b], points[c]), fill=1)
            empty = Image.new(image.mode, image.size, color=0)
            image = Image.composite(image, empty, mask)

    return image.transpose(Transpose.FLIP_TOP_BOTTOM)


def extract(bundle: Path, output: Path, requested_name: str, unity_version: str, bundle_name: str = "") -> dict:
    # Keep the dependency directory local to this worker so the importer also
    # works on a clean machine after the documented UnityPy bootstrap step.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".data" / "pydeps"))
    import UnityPy  # pylint: disable=import-outside-toplevel

    UnityPy.config.FALLBACK_UNITY_VERSION = unity_version
    raw = bundle.read_bytes()
    # Masking is keyed by the catalog asset name (for example
    # ``img_card_full_00012-...``), not by the short objectName used in the
    # download URL.  Keep the stem as a compatibility fallback for old caches.
    decoded = unmask(raw, bundle_name or requested_name)
    if not decoded.startswith(b"UnityFS") and requested_name and bundle.stem != requested_name:
        decoded = unmask(raw, bundle.stem)
    environment = UnityPy.load(decoded)
    candidates = []
    for object_type in ("Sprite", "Texture2D"):
        for obj in environment.objects:
            if obj.type.name != object_type:
                continue
            try:
                data = obj.read()
                image = sprite_image(data) if object_type == "Sprite" else getattr(data, "image", None)
                if image is None:
                    continue
                name = str(getattr(data, "m_Name", "") or obj.peek_name() or "")
                width = int(getattr(image, "width", 0) or 0)
                height = int(getattr(image, "height", 0) or 0)
                candidates.append((name, object_type, image, width, height))
            except Exception:
                continue
    if not candidates:
        raise RuntimeError(f"no Sprite/Texture2D image found in {bundle}")
    selected = next((item for item in candidates if item[0] == requested_name), None)
    if selected is None:
        # A bundle contains one art object in the current catalog.  Keep a
        # deterministic fallback for releases that rename the Unity object.
        selected = candidates[0]
    name, object_type, image, width, height = selected
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG", optimize=True)
    return {
        "name": name,
        "type": object_type,
        "width": width,
        "height": height,
        "path": str(output),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--name", default="")
    parser.add_argument("--bundle-name", default="", help="catalog asset name used to unmask a shared bundle")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--unity-version", default="6000.0.60f1")
    args = parser.parse_args()
    result = extract(args.bundle, args.output, args.name, args.unity_version, args.bundle_name)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
