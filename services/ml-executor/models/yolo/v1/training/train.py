"""
Full training pipeline: YOLO train → ONNX export → deploy to model directory.

Run from this training/ directory:
    python train.py

Or use the VS Code "Train ML Executor Model" launch configuration.

After training completes, the best.onnx is copied to the parent model directory
(models/yolo/v1/yolo.onnx). Restart the service to load the updated model.

To add a new dataset, create datasets/<name>/ with the same layout as datasets/v1/
and pass its data.yaml via --data.
"""

import argparse
import shutil
from pathlib import Path

TRAINING_DIR = Path(__file__).parent          # models/yolo/v1/training/
MODEL_DIR    = TRAINING_DIR.parent            # models/yolo/v1/


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Train YOLO detection model and export to ONNX')
    parser.add_argument(
        '--data',
        default='datasets/v1/data.yaml',
        help='Path to dataset data.yaml (relative to training/)',
    )
    parser.add_argument(
        '--base-model',
        default='yolo11n.pt',
        help='Base YOLO weights to fine-tune from (downloaded automatically if absent)',
    )
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--imgsz', type=int, default=640)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument(
        '--name',
        default='run',
        help='Training run name — output saved to training/runs/<name>/',
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    try:
        from ultralytics import YOLO  # type: ignore[import]
    except ImportError:
        raise SystemExit(
            'ultralytics is not installed.\n'
            'Run:  pip install -r requirements.txt'
        )

    runs_dir = TRAINING_DIR / 'runs'

    print(f'Dataset config : {args.data}')
    print(f'Base model     : {args.base_model}')
    print(f'Epochs         : {args.epochs}')
    print(f'Image size     : {args.imgsz}')
    print(f'Batch size     : {args.batch}')
    print(f'Run name       : {args.name}')
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

    best_pt = Path(results.save_dir) / 'weights' / 'best.pt'
    print(f'\nExporting {best_pt} to ONNX...')

    best_model = YOLO(str(best_pt))
    best_model.export(format='onnx', imgsz=args.imgsz)

    onnx_src = best_pt.with_suffix('.onnx')
    if not onnx_src.exists():
        raise FileNotFoundError(f'Expected ONNX export at {onnx_src}')

    dest = MODEL_DIR / 'yolo.onnx'
    shutil.copy(str(onnx_src), str(dest))
    print(f'New model deployed → {dest}')
    print('Restart the service to load the updated model.')


if __name__ == '__main__':
    main()
