"""Train and evaluate the experimental WakeTrace Sentinel-1 slick screen."""
from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "data" / "external" / "oilspill-detection-dataset"
WEIGHTS = ROOT / "backend" / "models" / "oil_slick_tinyunet_v1.pt"
REPORT = ROOT / "backend" / "models" / "oil_slick_training_report.json"
sys.path.insert(0, str(ROOT / "backend" / "app" / "detection"))
from _tiny_unet import TinyUNet


class Tiles(Dataset):
    def __init__(self, split: str):
        with (DATASET / "splits" / f"{split}.csv").open(encoding="utf-8", newline="") as f:
            self.rows = list(csv.DictReader(f))
        self.split = split

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        image = Image.open(DATASET / row["image_path"]).convert("RGB").resize((400, 300), Image.Resampling.BILINEAR)
        mask = Image.open(DATASET / row["mask_path"]).convert("L").resize((400, 300), Image.Resampling.NEAREST)
        x = np.asarray(image, dtype=np.float32).copy() / 255.0
        y = (np.asarray(mask, dtype=np.uint8) > 0).astype(np.int64)
        return torch.from_numpy(x).permute(2, 0, 1), torch.from_numpy(y)


def evaluate(model, loader, device):
    model.eval()
    tp = fp = fn = tn = 0
    with torch.inference_mode():
        for x, y in loader:
            prediction = model(x.to(device)).argmax(1).cpu().numpy().astype(bool)
            target = y.numpy().astype(bool)
            tp += int(np.logical_and(prediction, target).sum())
            fp += int(np.logical_and(prediction, ~target).sum())
            fn += int(np.logical_and(~prediction, target).sum())
            tn += int(np.logical_and(~prediction, ~target).sum())
    return {
        "slick_iou": tp / max(tp + fp + fn, 1),
        "precision": tp / max(tp + fp, 1),
        "recall": tp / max(tp + fn, 1),
        "pixel_accuracy": (tp + tn) / max(tp + tn + fp + fn, 1),
        "counts": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--epochs", type=int, default=8)
    args = p.parse_args()
    random.seed(42)
    np.random.seed(42)
    torch.manual_seed(42)
    torch.set_num_threads(4)
    device = torch.device("cpu")
    train = Tiles("train")
    val = Tiles("val")
    test = Tiles("test")
    train_loader = DataLoader(train, batch_size=4, shuffle=True, num_workers=0)
    val_loader = DataLoader(val, batch_size=4, shuffle=False, num_workers=0)
    test_loader = DataLoader(test, batch_size=2, shuffle=False, num_workers=0)
    model = TinyUNet().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=7e-4)
    best_iou = -1.0
    history = []
    WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        model.train()
        loss_sum = 0.0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(x)
            loss = F.cross_entropy(logits, y, weight=torch.tensor([1.0, 4.0], device=device))
            loss.backward()
            optimizer.step()
            loss_sum += float(loss.item())
        metrics = evaluate(model, val_loader, device)
        history.append({"epoch": epoch, "train_loss": loss_sum / max(len(train_loader), 1), "validation": metrics})
        print(f"epoch {epoch}/{args.epochs}: train_loss={loss_sum / max(len(train_loader), 1):.4f} val_slick_iou={metrics['slick_iou']:.4f} precision={metrics['precision']:.4f} recall={metrics['recall']:.4f}", flush=True)
        if metrics["slick_iou"] > best_iou:
            best_iou = metrics["slick_iou"]
            torch.save({"model_state": model.state_dict(), "base_ch": 8, "input_size": [300, 400], "epoch": epoch}, WEIGHTS)
    checkpoint = torch.load(WEIGHTS, map_location=device, weights_only=True)
    model.load_state_dict(checkpoint["model_state"])
    report = {
        "model": "WakeTrace experimental Sentinel-1 slick-like TinyUNet v1",
        "architecture": "Two-class TinyUNet, base_ch=8, 300x400 inputs",
        "dataset": "Garcia et al. (2026), INPE Oil Spill Segmentation Dataset, CC BY 4.0, https://github.com/Garcia-INPE/oilspill-detection-dataset",
        "split_counts": {"train": len(train), "validation": len(val), "test": len(test)},
        "split_policy": "Dataset-provided tile/source-separated manifests; test split was held out during training and model selection.",
        "best_epoch": checkpoint["epoch"],
        "best_validation_slick_iou": best_iou,
        "test": evaluate(model, test_loader, device),
        "history": history,
        "limitations": "The source dataset covers Cantarell, Gulf of Mexico, Jan–Sep 2020. Test performance is in-domain and does not establish generalization to Mauritius or all Sentinel-1 modes, seasons, wind states, or look-alikes. Scores are not calibrated probabilities; detections require expert and independent evidence review.",
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("test:", json.dumps(report["test"], separators=(",", ":")), flush=True)
    print("saved:", WEIGHTS, REPORT, flush=True)


if __name__ == "__main__":
    main()
