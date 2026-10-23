# WakeTrace experimental SAR slick-like segmentation model

## Model and intended use

The oil_slick_tinyunet_v1.pt checkpoint is a two-class U-Net trained to highlight Sentinel-1 SAR textures resembling the slick labels in the INPE Oil Spill Segmentation Dataset. It is an experimental review aid. A model score is not a probability, an oil confirmation, or a vessel attribution.

The model runs alongside WakeTrace's rule-based dark-feature screen. It draws separate violet outlines. Analysts should compare both screens with the underlying radar, wind and current context, and source-backed AIS evidence.

## Training data and attribution

- Garcia et al. (2026), *Oil Spill Segmentation Dataset*, Instituto Nacional de Pesquisas Espaciais (INPE).
- 173 Sentinel-1 tiles from the Cantarell region, Gulf of Mexico, January–September 2020.
- Dataset-provided source-separated splits: 108 training tiles, 43 validation tiles, 22 held-out test tiles.
- Binary classes: sea/background and slick (oil spill or seepage labels merged).
- Licensed CC BY 4.0. Attribution and dataset: https://github.com/Garcia-INPE/oilspill-detection-dataset
- The dataset and its baseline architecture were adapted with attribution; see backend/app/detection/_tiny_unet.py.

## Training and measured performance

The model uses a compact U-Net with 8 base channels, 400 × 300 inputs, Adam optimization, and weighted cross entropy. The best checkpoint was chosen by validation slick IoU; the test split was not used for model selection. Training details are recorded in oil_slick_training_report.json.

Held-out test results:

| Metric | Result |
| --- | ---: |
| Slick IoU | 0.618 |
| Precision | 0.930 |
| Recall | 0.648 |
| Pixel accuracy | 0.996 |

Pixel accuracy is dominated by the sea/background class and should not be used alone. Metrics are this run's reproduction on the published split; they are not a claim of performance on new locations.

## Important limitations

The data is geographically and temporally narrow and does not establish performance for Mauritius, other sea states, all Sentinel-1 modes or acquisition conditions. Dark or smooth SAR regions can also be caused by low wind, rain, wakes, wave fronts, shadows, or other effects. Regional domain shift is expected. Human review and independent evidence are required.

Live-scene inputs are calibrated sigma0 dB values stretched between their 2nd and 98th valid-pixel percentiles and resized to the training input dimensions. This helps align display range but does not remove differences in geography, acquisition conditions, or preprocessing.

## Reproduce training

Download the licensed repository into data/external/oilspill-detection-dataset/, install backend/ml-requirements.txt in a Python 3.10–3.14 environment, then run:

```powershell
python backend/scripts/train_slick_model.py --epochs 8
```

The script chooses the checkpoint by validation IoU, evaluates once on the provided test split, and writes the weights and report under backend/models/.
