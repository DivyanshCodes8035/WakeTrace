"""Satellite-image screening tools for possible slick features."""

from .sar import DetectionInputError, detect_sar_dark_features

__all__ = ["DetectionInputError", "detect_sar_dark_features"]
