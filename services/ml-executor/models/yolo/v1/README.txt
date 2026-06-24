yolo / v1 — YOLOv8-nano lettuce health detector
================================================

Source:    https://universe.roboflow.com/-4ydsj/lettuce-j9wu0-lmci0
License:   CC BY 4.0
Exported:  2026-05-30 via Roboflow

Dataset: 5170 images, YOLO format, 640x640 (stretch resize, no augmentation)

Classes (index → label):
  0  Belum Matang  — Immature
  1  Matang        — Mature
  2  Rusak         — Damaged

Model file: yolo.onnx  (YOLOv8-nano, input 1×3×640×640 float32, output [1, N, 6]: cx,cy,w,h,conf,class_id)
