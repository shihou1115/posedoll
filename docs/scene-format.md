# シーン JSON 形式（posedoll-scene 2.1）

デッサン人形ポーザーの「シーンを JSON で保存」と ZIP 内の `*_scene.json` の形式。
この文書と JSON だけで、他のツール（Blender など）で同じ骨格・ポーズ・カメラを組み直せることを目標にしている。
Blender 用の読み込みスクリプトは `tools/blender_import.py`。

- 版: `formatVersion: "2.1"`（v1.7 で追加）。`v: 2` は従来どおり。2.1 は 2 に項目を足しただけで、アプリは 2.0 のファイルも読める。
- 2.1 で足したのは「ファイル保存のときだけ」付く付録（`skeleton`・`cam.lens`・`props[].parts`）と、`cam.frameFov`。
  アプリは付録 3 つを読み込みには使わない（ポーズ・体型・カメラの値から作り直す）。
  **`cam.frameFov` は読み込みに使う**（`fov` の意味を決める印。消すと v1.6 以前の画角として約 0.84 倍に読み替えられ、構図が変わる）。
  他のツールでシーン JSON を書き換えるときは `frameFov` を残すこと。

## 約束事

| 項目 | 値 |
|---|---|
| 単位 | メートル |
| 座標系 | 右手系、**+Y が上**、人形の正面は **+Z**、**本人の左が +X**（three.js と同じ） |
| 角度 | 度 |
| 関節の回転順 | Euler **XZY**（three.js の `'XZY'`：回転行列 = Rx · Rz · Ry。ひねり Y が最後に効く） |
| 小道具の回転順 | Euler **XYZ**（three.js の既定：Rx · Ry · Rz） |
| 左右 | 名前の L / R は本人から見た左右。左右反転は角度 `(x, -y, -z)` を反対側の関節へ |
| 精度 | 角度 0.1°、位置 1mm（`skeleton` は 1µm） |

Blender（+Z が上）へは `(x, y, z) → (x, -z, y)`（X 軸まわり +90° の回転）で移す。
回転順の対応: three.js の `'XZY'` = Blender の回転モード `'YZX'`、three.js の `'XYZ'` = Blender の `'ZYX'`
（three.js は「行列の掛け算の順」、Blender は「回す順」で書くため逆に並ぶ）。

この形式が他のツールで組み直せることは Blender 5.2.1 で確かめた（`tests/blender/`、結果は `docs/blender-verification.md`）。

## 全体

```json
{
  "format": "posedoll-scene", "formatVersion": "2.1", "v": 2,
  "figures": [ 人物 ... ],
  "props": [ 小道具 ... ],
  "active": 0,
  "cam": カメラ
}
```

## 人物 `figures[i]`

```json
{ "name": "人物1", "pos": [x,y,z], "body": {...}, "pose": {"rot": {...}, "root": [x,y,z]}, "skeleton": {...} }
```

- 人物の基準（three.js の Group）: 位置 `pos`、拡大率 `body.height`（3軸同じ）、回転なし。
- `body`: 体型の倍率 `height head shoulder hipW torso arm leg thick`（1 が標準）。骨の長さへの反映はアプリの式による。
  他のツールでは `skeleton` の `offset` を使えばよい（体型を反映済み）。
- `pose.rot`: 関節名 → `[x,y,z]` 度（XZY）。**書かれていない関節は 0**。
- `pose.root`: 腰（`hips`）の位置。人物の基準の中の座標（拡大率 `height` がかかる前）。

### 関節（47 個）
- 体 17: `hips spine chest neck head shoulderL elbowL wristL shoulderR elbowR wristR hipL kneeL ankleL hipR kneeR ankleR`
- 指 30: `f{L|R}_{thumb|index|middle|ring|pinky}{1|2|3}`（1 = 付け根、2 = 第2関節、3 = 第1関節。親指は付け根・中間・先）

### `skeleton`（2.1）

```json
{
  "units":"m", "up":"+Y", "front":"+Z", "left":"+X", "euler":"XZY", "angles":"deg",
  "nodes": { "名前": {"parent": "親の名前|null", "offset": [x,y,z], "joint": true} | {"parent":..., "offset":..., "rest":[x,y,z], "scale": s} },
  "marks": { "名前": {"parent": "ノード名", "offset": [x,y,z]} },
  "face":  { "parent": "headGroup", "points": [[x,y,z] × 68] }
}
```

- `nodes` は親が先に並ぶ。`parent: null` は人物の基準（Group）。
  - `joint: true` … 関節。回転は `pose.rot` の値（無ければ 0）。`hips` の位置は `offset` ではなく `pose.root` を使う。
  - それ以外は固定のノード。回転は `rest`（XZY・度）、拡大は `scale`（無ければ 1）。
    - `headGroup`（親 `head`）… 頭の大きさの拡大だけ（`scale` = `body.head`）。目・耳・鼻・顔の点の親。
    - `fL_thumbBase` / `fR_thumbBase`（親 `wrist`）… 親指の付け根の向き。親指の関節の親。
- ノードの変換 = 平行移動(`offset`) · 回転(XZY) · 拡大(`scale`)。ワールド = 人物の基準 · … · 親 · 自分。
- `marks`（OpenPose の点のうち関節以外）:
  `nose eyeL eyeR earL earR`（親 headGroup）、`{L|R}_{thumb|index|middle|ring|pinky}_tip`（指先、親は各指の 3）、
  `{L|R}_{bigtoe|smalltoe|heel}`（足裏の点、親 ankle）。
- `face`: DWPose と同じ iBUG 68 点の順の顔の点（headGroup の空間）。アプリでは頭の向きで隠れる点を描かない。

### OpenPose の点の作り方
- COCO-18（`pose_keypoints_2d` の順）: 0 nose, 1 neck（左右の肩の中点）, 2 shoulderR, 3 elbowR, 4 wristR, 5 shoulderL, 6 elbowL, 7 wristL,
  8 hipR, 9 kneeR, 10 ankleR, 11 hipL, 12 kneeL, 13 ankleL, 14 eyeR, 15 eyeL, 16 earR, 17 earL。
- 手 21 点: wrist, 各指（thumb, index, middle, ring, pinky の順）の 1, 2, 3, tip。
- 足 6 点（COCO-WholeBody の順）: L_bigtoe, L_smalltoe, L_heel, R_bigtoe, R_smalltoe, R_heel。
- 見える・見えないの判定（顔・耳・目）はアプリの描画用の近似で、この形式には含めない。

## 小道具 `props[i]`

```json
{ "type": "chair", "pos": [x,y,z], "rot": [x,y,z], "scl": [x,y,z], "parts": [ {"shape":"box|cylinder", "size":[x,y,z], "pos":[x,y,z]} ] }
```
- 変換 = 平行移動(`pos`) · 回転(XYZ・度) · 拡大(`scl`)。
- `parts`（2.1）: 小道具の空間の中の部品。`box` は 1×1×1 の箱、`cylinder` は半径 1・高さ 1（軸 Y）の円柱を、中心 `pos` に置いて `size` 倍したもの。
- `type`: `chair box steps table wall pillar`。

## カメラ `cam`

```json
{ "pos":[x,y,z], "target":[x,y,z], "fov": 30, "frameFov": true, "size":[W,H], "place":[x,y,s],
  "lens": {"fovY": 26.1, "aspect": 1.75, "center": [cx, cy], "size":[W,H]} }
```
- 向き: `pos` から `target` を見る。上方向は +Y（ロールなし）。カメラは自分の −Z を向き、+Y が画面の上（three.js / Blender 共通）。
- `fov`: 書き出し枠の縦の画角（度、整数）。`frameFov: true` がその意味であることの印（v1.7 以降。読み込みで使うので省かないこと。`formatVersion` だけでは判断しない）。
  - **印の無い v1.6 以前のファイル**では `fov` は画面のカメラの画角で、書き出し枠の中身はブラウザの窓の大きさで変わっていた。
    アプリは `fov × 約 0.84`（tan で換算）として読み込む（よくある窓の大きさでの見た目に合わせた近似）。
- `size`: 書き出し画像のピクセル数。`place`: 枠の中の配置（左右・上下は枠の幅・高さに対する割合で右・上が＋、`s` は大きさ）。
- `lens`（2.1）: **書き出し画像そのもののカメラ**。他のツールはこれを使えばよい。
  - `fovY`: 画像の縦の画角（`place.s` の拡大を含む）。`aspect`: 横 / 縦。
  - `center`: 視線の軸が画像のどこに来るか（NDC：中央 0、右・上が＋、端が ±1）。`place` の左右・上下のずれから来る。
  - 投影: カメラ座標の点を、縦画角 `fovY`・縦横比 `aspect` の左右対称なカメラで NDC (nx, ny) にしてから、
    `x_px = ((nx + cx) + 1) / 2 · W`、`y_px = (1 − (ny + cy)) / 2 · H`（y は上から下）。
  - Blender: センサーを縦合わせ（`sensor_fit = 'VERTICAL'`）、`angle_y = fovY`、
    `shift_x = −cx · W / (2·H)`、`shift_y = −cy / 2`、解像度 W×H（`resolution_percentage = 100`、画素の縦横比 1）。
    Blender のシフトは「合わせる向きの辺」（縦合わせなら縦 H）が単位で、正の値で写る範囲が右・上へずれる（軸は左・下へ動く）ので符号が逆になる。
  - カメラの向き（Blender）: three.js の座標で `pos` から `target` へ lookAt した行列を、X 軸まわり +90° の親の下に置く
    （または左から +90° の回転を掛ける）。カメラは −Z を向き +Y が上なので、three.js と同じ行列のままでよい。

## 保存庫の 1 件（参考）
`{posedollPose:1, name, created, pose, body, cam?, thumb}`。`cam` は腰からの相対（`rel:'hips'`）で、`lens` や `skeleton` は入らない。
