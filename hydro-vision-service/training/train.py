"""
Full training pipeline: YOLOv8 train → ONNX export → deploy to service root.

Run from the hydro-vision-service/ directory:
    python training/train.py

Or use the VS Code "Train Hydro Vision Model" launch configuration.

After training completes, best.onnx in the service root is overwritten with
the newly trained model. Restart the service to pick up the new model.

To add a new dataset, create training/datasets/<name>/ with the same layout
as lettuce-v1 and pass its data.yaml via --data.
"""

import argparse
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train lettuce detection model and export to ONNX"
    )
    parser.add_argument(
        "--data",
        default="training/datasets/lettuce-v1/data.yaml",
        help="Path to dataset data.yaml (relative to hydro-vision-service/)",
    )
    parser.add_argument(
        "--base-model",
        default="yolo11n.pt",
        help="Base YOLO weights to fine-tune from (downloaded automatically if absent)",
    )
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument(
        "--name",
        default="lettuce-hydro",
        help="Training run name — output saved to training/runs/<name>/",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # Import here so the file is importable without ultralytics installed
    # (e.g. for type checking or IDE navigation).
    try:
        from ultralytics import YOLO  # type: ignore[import]
    except ImportError:
        raise SystemExit(
            "ultralytics is not installed.\n"
            "Run:  pip install -r training/requirements.txt"
        )

    service_root = Path(__file__).parent.parent
    runs_dir = service_root / "training" / "runs"

    print(f"Dataset config : {args.data}")
    print(f"Base model     : {args.base_model}")
    print(f"Epochs         : {args.epochs}")
    print(f"Image size     : {args.imgsz}")
    print(f"Batch size     : {args.batch}")
    print(f"Run name       : {args.name}")
    print()

    model = YOLO(args.base_model)
    results = model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        name=args.name,
        project=str(runs_dir),
    )

    best_pt = Path(results.save_dir) / "weights" / "best.pt"
    print(f"\nExporting {best_pt} to ONNX...")

    best_model = YOLO(str(best_pt))
    best_model.export(format="onnx", imgsz=args.imgsz)

    onnx_src = best_pt.with_suffix(".onnx")
    if not onnx_src.exists():
        raise FileNotFoundError(f"Expected ONNX export at {onnx_src}")

    dest = service_root / "best.onnx"
    shutil.copy(str(onnx_src), str(dest))
    print(f"✓  New model deployed → {dest}")
    print("   Restart the service to load the updated model.")


if __name__ == "__main__":
    main()
