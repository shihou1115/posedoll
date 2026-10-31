# デッサン人形ポーザー — 開発メモ（Claude 用）

ComfyUI の OpenPose ControlNet 用に、3D デッサン人形でポーズを作って参照画像を書き出すツール。
**ローカル運用・スタンドアロン**が前提。`posedoll.html` をダブルクリックで開き、ネット接続なしで動くこと。

## フォルダ構成

```
posedoll.html      ビルド成果物（これ1つで動く。直接編集しない）
README.txt         利用者向けの使い方
CLAUDE.md          このファイル
src/app.js         アプリ本体のソース（ES モジュール）
src/llmpose.js     言葉でポーズ（v1.5）: LLM の返事 JSON の読み取りと関節角への変換（three.js 非依存）
src/llm_prompt.md  LLM 向け指示書の原本。build.py が app に文字列で埋め込み、ルートに LLM_POSE.md としてコピーする
LLM_POSE.md        ビルド成果物（指示書）。直接編集しない
src/skin.js        人体の見た目の肌メッシュ生成（距離場 → surface nets → 骨の重み。three.js 非依存の計算だけ）
src/template.html  HTML / CSS。__JSZIP__ と __BUNDLE__ の位置にスクリプトが差し込まれる
src/build.py       ビルド（esbuild で app.js と three.js を1本にまとめ、template に埋め込む）
src/smoke_test.js  自動の動作確認（Playwright）
docs/scene-format.md         シーン JSON の仕様書（形式 2.1）。形式を変えたら必ず更新する
docs/blender-verification.md Blender での形式検証の結果（v1.7）
tools/blender_import.py      シーン JSON を Blender に読み込むスクリプト（Blender 内で実行）
tests/blender/               形式の検証: make_cases.js（アプリで正解を作る）, cases/, run_check.py（Blender 内で比較）, results.json
vendor/            three.js r160（three.module.min.js / OrbitControls.js / TransformControls.js）, jszip.min.js 3.10.1
library/           利用者の保存庫（ポーズ1件 = JSON 1ファイル）。利用者のデータなので消さない・書き換えない
```

## 作業の進め方

1. `src/app.js` と `src/template.html` を編集する（`posedoll.html` は直接いじらない）。
2. `python src/build.py` でビルド → `posedoll.html` が更新される。
3. `node src/smoke_test.js` で確認し、`errors` が空で全項目 true / 期待値になっていることを見る。
4. 見た目が関わる変更はスクリーンショットでも確認する。
5. バージョン番号（template.html の h1 内）と下の「変更履歴」を更新する。
6. 骨格・関節の向き・カメラ・小道具の形を変えたら、`node tests/blender/make_cases.js` で正解を作り直し、
   Blender（MCP）で `tests/blender/run_check.py` を exec して `results.json` の `pass` が true か確かめる。`docs/scene-format.md` も直す。

ビルドと確認に esbuild・Playwright が要る。ユーザーの PC 側のシェルにはない（ネットも使えない）ので、
**クラウド側の作業環境に src/ と vendor/ を持ってきてビルド・テストし、成果物だけ PC に書き戻す**。
クラウド側の esbuild: `/opt/npm-tools/node_modules/esbuild/bin/esbuild`（build.py が自動で探す）。

## 守ること

- 外部への通信を入れない（CDN・Google Fonts・API など）。ライブラリは vendor/ に置いてバンドルする。
- three.js は r160 に固定。r169 以降は TransformControls の使い方が変わる（`scene.add(gizmo)` が使えなくなる）。
- `file://` で開くので ES モジュールのファイル分割は不可（Chrome がブロックする）。必ず1ファイルにバンドルする。
- 保存庫 JSON とシーン JSON の形式は後方互換を保つ（古いファイルも読めること）。
- UI の文言は日本語。

## アプリの仕組み（src/app.js）

### 座標と関節の約束
- 人形は +Z を向く。**本人の左 = +X**。名前の L/R は本人から見た左右。
- 関節は Object3D の階層。Euler 順は **XZY**（ひねり Y が最後に効く）。
- 手足: **X マイナス = 前へ曲げる**（肩の前挙・股関節の屈曲）、ひじは X マイナスで曲がる、ひざは X プラス。
  左側の Z プラス = 外へ開く。右側は鏡像（左右反転は `(x, -y, -z)` で入れ替え）。
- 胴・首は X プラスで前屈。足首は X プラスでつま先が下がる。
- 体の関節 17 個（`BODY_JOINTS`）＋ 指 15 個 × 左右（`fL_index1` など。1=付け根、2=第2関節、3=第1関節。親指は付け根/中間/先）。
- 可動域は `LIM`（本人の左側の度数）。右側は `limitsFor()` で y・z を反転して使う。

### 主なまとまり
- `class Figure` … 1人分の人形。`build()` で関節と部品を作り、`applyBody()` で体型（`BODY_DEF` の8項目）を反映。
  `getState()/setState()` で人物ごとの状態（名前・位置・体型・ポーズ）。
- `PRESETS` … 体のポーズ。`HAND_PRESETS` … 手の形（親指〜小指の曲げ量 0〜1 と指の開き）。
- `Prop` … 小道具（椅子・箱・段差・テーブル・壁・柱）。
- `solveLimb()` … 2 ボーン IK（ひじ/ひざの曲げ角を余弦定理で決め、付け根を目標へ向ける）。足は向きを保つ、手は前腕に従う。
- ひじ/ひざの IK 球（v1.4、`IK_MIDS`、手首・足首の 0.8 倍の大きさ）。
  - ひざ `solvePole()` … 付け根→足首の軸のまわりに股関節を回し、ひざを目標の側へ振る。足首の位置と向きは保つ。脚がまっすぐなら脚全体を目標へ向ける。
  - ひじ `solveElbow()` … 上腕を最短の回転で目標へ向け（ひねらない）、ひじの曲げだけで手をドラッグ開始時の位置（anchor）へ近づける。
    手の向きは前腕に従う。手を固定する方式は、ありえないひねりが要る場面が多く可動域の制限で腕が暴れたのでやめた。
  - 軸まわりの回転は `rollAbout()`（setFromUnitVectors は 180° 付近で軸が不定になる）。
- `setWorldQuat()` は `tidyEuler()` で XZY の別解 (x+180, 180−z, y+180) のうち曲げ・ひねりが小さい方にそろえる（可動域の clamp が壊れないように）。
- `drawOpenPose(ctx,W,H,cam,opOpts())` … controlnet_aux と同じ描き方（体 COCO-18 の色と太さ、手 21 点は HSV 色の線＋青い点）。
  v1.6 で任意の顔の点と足先を追加（出力タブ、選択は localStorage `posedoll:op`）。
  - 顔 `kpFace()` … DWPose と同じ iBUG 68 点の順。頭の楕円（headGroup 空間）上の型 `FACE_TPL` から作る近似。頭の中心から外向きがカメラの反対なら隠す。
    白い点、半径は短辺/170（DWPose は 512px で半径 3）。
  - 足先 `kpFoot()` … COCO-WholeBody の順（左の親指側・小指側・かかと、右も同じ）。人形の足の楕円（`footMesh`）の足裏寄りの点。
    comfyui_controlnet_aux の DWPose は足の点を描かない（取り出すが捨てる）ので、描き方は2つから選ぶ:
    `body25` = OpenPose BODY_25（足首→親指・親指→小指・足首→かかと、左 (0,0,255) 右 (0,255,255)）、
    `toe` = Wan Animate（kijai/ComfyUI-WanAnimatePreprocess）の 1点（親指と小指の中点、左 (200,200,0) 右 (100,100,0)）。棒の太さ・透明度は体と同じ。
- 真横の警告（v1.6）… `sideness()` = 肩の線・腰の線と視線のなす角の sin の大きい方。`SIDE_WARN`（0.3 ≒ 17°）未満で出力タブに警告、書き出し枠も赤くなる。
- 枠の中の配置（v1.6）… `place {x,y,s}`（枠の幅・高さに対する割合、右・上が＋、大きさ 0.4〜2.5）。画面のカメラにも `setViewOffset` で
  レンズシフト＋拡大をかけ（`applyPlace()`）、`exportCam()` も同じずれを合成するので、枠の見た目＝書き出し。遠近は変わらない。
- 画角（v1.7）… 画角スライダーの値 `expFov` は**書き出し枠の縦の画角**。画面のカメラの画角は `syncFov()` が枠の高さから逆算する
  （窓の大きさが変わっても書き出しの構図は変わらない）。`exportCam()` は pos/target/expFov/size/place だけで決まる（窓に依存しない）。
  `viewPose()` の距離も `expFov` から。v1.6 以前の保存（`frameFov` の印なし）の fov は画面の画角なので `LEGACY_FOV_K`（0.84、tan で換算）で読み替える。
- 形式の付録（v1.7）… `sceneFile()` がファイル保存時だけ `formatVersion`・`skeleton`（`skeletonOf()`）・`cam.lens`（`camLens()`）・`props[].parts`（`Prop.parts()`）を付ける。
  アプリは読み込みでこれらを使わない。足裏の点は `FOOT_SOLE`（`kpFoot()` と `skeletonOf()` で共用）。
- `renderImage(kind)` … 'doll' / 'openpose' / 'depth' / 'normal' / 'lineart' を書き出し枠（`exportCam()`）で描く。
- 保存まわり … File System Access API。選んだフォルダのハンドルは IndexedDB（DB `posedoll`、ストア `kv`、キー `dir_lib` / `dir_out`）に記憶。
  未対応ブラウザ（Firefox）では保存庫は localStorage（`posedoll:lib`）。
- 自動保存 … localStorage `posedoll:v2`（シーン）、`posedoll:cam`（視点・画角・出力サイズ・枠の中の配置）、`posedoll:op`（OpenPose の手・顔・足先）、`posedoll:batch`（一括書き出しの選択）、ほかに `posedoll:tab` `posedoll:ik` `posedoll:lim` `posedoll:floor` `posedoll:look`。
- 見た目（v1.3）… `look`（'human' 既定 / 'doll'）。localStorage `posedoll:look`。体型タブのボタンで切り替え。
  - 人体: `ANAT`（体）と `ANAT_HAND`＋指（手）の球・角丸円錐・角丸箱を、骨ごとのローカル座標（本人の左側、右は x 反転）で定義。
    体型の効き方は `SK_F`。`updateSkin()` がバインド姿勢（肩 ±45°・股 ±8°・指を開く）で距離場を作り、`skin.js` の `buildSkin()` で
    体1枚（格子 6.5mm）＋手2枚（2.2mm）の SkinnedMesh にする。骨は関節の Object3D そのもの（頭だけ headGroup）。
  - 重み: いちばん近い形の骨と、その親・子の骨だけに距離差で配分（左右の脚が混ざらない）。手首は体側に重み専用の形（ghost）を置く。
  - 作り直しは体型が変わったときだけ（`syncSkin()`、キーは body の JSON）。スライダー操作中は粗く（格子 1.8 倍）、離して 350ms 後に細かく。
    書き出し前は必ず細かく作る。細かい作り直しは 1 人 0.3〜0.4 秒ほど。
  - 人形の部品（`meshes`）は人体のときも残し、`visible=false` でクリック判定・接地・深度の範囲計算に使う（Raycaster は visible を見ない）。
  - 選択中の部位は頂点属性 `aSel`（関節番号）と uniform `uSel` で青く塗る（`skinMaterial()`）。
  - 深度の ShaderMaterial はスキニングの chunk を入れてある（入れないとバインド姿勢で描かれる）。
- 言葉でポーズ（v1.5）… ポーズタブの「言葉でポーズ（LLM）」。`llmPrompt()` が指示書＋利用者の文章をコピー、`applyLLM(text)` が貼られた返事を反映。
  - LLM には軸ではなく意味の名前（bend / front / side / turn / tilt / rotate / point）で、左右とも同じ向きの数値を書かせる。
    `llmpose.js` の `MAP` が本人の左側の [軸, 符号] に直し、R は (x,-y,-z) で鏡写し。配列 [x,y,z] はそのままの関節角として読む。
    向きは実測で決めた（hips/胴/首/頭: X+ 前屈、Y+ 本人の左を向く、Z+ 本人の右へ傾く。肩・股: Y+ 外ひねり。手首: Z+ 手の甲側、X+ 小指側。ひじ: Y+ 手のひらが上）。
  - `parseLoose()` はコードブロック・前後の文章・コメント・末尾カンマ・' を許す。関節名は left_shoulder なども `jointKey()` で読む。
  - 書かれなかった関節は 0、指は hands が無ければ今のまま、腰の向きは hips が無ければ今のまま。最後に接地し、`lift` だけ浮かせる。
  - シーン JSON（figures）や保存庫 1件（posedollPose）を貼っても読める。
  - 指示書のコツ（腰に手・腕組み・頭の後ろで手）はスクリーンショットで確かめた値。指示書を変えたら例がアプリで正しく見えるか確かめる。
- デバッグ用 … `window.__pose`（smoke_test.js がこれを使う）。

### データ形式
- 詳しい仕様は `docs/scene-format.md`（他のツール向けの約束事もここ）。
- シーン JSON: `{format:'posedoll-scene', formatVersion:'2.1', v:2, figures:[{name, pos, body, pose:{rot:{関節名:[x,y,z]度}, root:[x,y,z]}}], props:[{type,pos,rot,scl}], active, cam?:{pos,target,fov,size:[W,H]}}`。
  `cam` はファイル保存時だけ付く（undo 履歴・自動保存の `posedoll:v2` には入れない）。v1.6 で `cam.place:[x,y,s]`（枠の中の配置）を追加。
  シーンや `posedoll:cam` に `place` が無ければ配置なしに戻す。保存庫の cam に無ければ今の配置のまま。
  `v` がない古い形式 `{rot, root, head}` も読める。
  v1.7（形式 2.1）でファイル保存時に `figures[].skeleton`・`props[].parts`・`cam.lens` を追加（読み込みでは使わない）。
  `cam.frameFov`（v1.7）は `getCam()` が常に付ける印で、**読み込みで使う**（無いと古い画角として `LEGACY_FOV_K` で読み替える）。
- OpenPose JSON: `{people:[{pose_keypoints_2d(18×3), hand_left_keypoints_2d(21×3|null), hand_right_keypoints_2d, face_keypoints_2d(68×3|null), foot_keypoints_2d?(6×3)}], canvas_width, canvas_height}`。
  `foot_keypoints_2d` は足先を描くときだけ付く（描き方が 1点でも 6点で入れる）。
  座標は出力サイズのピクセル、見えない点は `[0,0,0]`。left/right は本人から見た左右。画像と同じ投影（kpBody/kpHand）。
- 保存庫 1件: `{posedollPose:1, name, created(ms), pose, body, cam?, thumb(dataURL JPEG)}`。`cam` は v1.2 以降（腰からの相対、`rel:'hips'`）。ファイル名は `日時_名前.json`
  （日本語名が使えないファイルシステムでは `日時_pose.json`）。

## 確認のコツ
- smoke_test.js は Chromium の仮想 GPU（swiftshader）で動く。フォルダ保存はブラウザ内の仮想フォルダ（OPFS）で代用している。
  この仮想フォルダは日本語のファイル名を受け付けないため、テストでは `日時_pose.json` 側の動きになる。
- 実際の Windows のフォルダ選択画面は自動では試せない。フォルダまわりを変えたら、ユーザーに実機で一度試してもらう。

## 改良要望
- 未対応の要望は requests/ フォルダにまとめてある。作業を始めるときに確認し、対応したらファイル末尾に対応内容と版を書き足すこと。

## 変更履歴
- v1.7（2026-10）requests/2026-10-30 の要望（データ形式の Blender 検証）に対応。シーン JSON を形式 2.1 に（`skeleton`・`cam.lens`・`props[].parts`・`frameFov`）、
  仕様書 `docs/scene-format.md`、`tools/blender_import.py`、検証 `tests/blender/`（4 ケース・695 点で最大 0.0008mm / 0.0005px）。
  検証中に「書き出しの構図がブラウザの窓の大きさで変わる」問題が見つかったので、画角を書き出し枠基準（`expFov`）に変えて直した。
  smoke_test に `skeleton`（skeleton からの組み直し）・`lens`・`propParts`・`formatTag`・`viewportFree` を追加。
- v1.6（2026-10）requests/2026-10-29 の要望（歩行アニメ検証）に対応。真横に近い角度の警告、OpenPose の足先（BODY_25 式 3点 / Wan Animate 式 1点）と
  顔の点（DWPose の白い点 68）、書き出し枠の中の配置と大きさ（`cam.place`）。smoke_test に `sideWarn` `feetFace` `faceBack` `feetToe` `feetOff` `place` `placeReset` `camOldFile`。
- v1.5（2026-10）言葉でポーズ。LLM 向け指示書（`src/llm_prompt.md` → `LLM_POSE.md`）のコピー／保存と、返事の JSON の貼り付け反映（`src/llmpose.js`）。
  アプリから LLM を呼ぶ方式（LM Studio 直接）は通信を足すので見送り。smoke_test に `llmPose`。
- v1.4（2026-10）IK モードでひじ・ひざの球も動かせるように（ひざ `solvePole()`、ひじ `solveElbow()`）。IK 後のオイラー角の別解をそろえる `tidyEuler()`。smoke_test に `ikElbow` `ikKnee`。
- v1.3（2026-10）人体の見た目を追加（posemy.art のような継ぎ目のない肌）。既定は人体、体型タブで「デッサン人形」に戻せる。
  距離場をなめらかに溶かし合わせた肌を surface nets で作り、関節にスキニング（外部データなし、ファイルは約 +14KB）。
  深度・法線・線画・人形の書き出しも人体で描かれる（深度シェーダーにスキニング対応を追加）。OpenPose は関節位置なので変わらない。
  smoke_test に look / pickSkin / depthPosed / skinRebuild / lookDoll を追加。手首は手と体が別メッシュなので細い境目が残る。
- v1.2（2026-10）追加機能（提案 https://claude.ai/artifact/GscBtaLMMBmqFJtb1beDTf の推奨順 1→3→2→6→4）。
  - カメラ保存: シーン JSON に任意項目 `cam:{pos,target,fov,size}` を追加（`v` は 2 のまま、無いファイルも読める）。
    読み込み時に戻すかは出力タブのチェックで選ぶ。保存庫 1件にも `cam`（腰からの相対位置、`rel:'hips'`）を入れ、
    「視点も反映」チェック時のみ適用（出力サイズは変えない）。最後の視点は localStorage `posedoll:cam` に自動保存。カメラは undo 対象外。
  - OpenPose JSON 書き出し（`openposeJSON()`）: 出力タブのボタンと ZIP（`_keypoints.json`）。
  - 法線・線画の書き出し: `renderImage('normal')`（MeshNormalMaterial、カメラ空間 R=右 G=上 B=手前、背景 #8080ff）、
    `renderImage('lineart')`（`lineArt()`: 法線と深度を透過で描き、輪郭・深度の段差・法線の折れ目を CPU で検出。黒地に白線）。ZIP にも入る。
  - ショートカット追加: Tab/Shift+Tab と ]/[ で関節送り（体 17 関節、指を選んでいるときはその手の指）、矢印で 1°（Shift 5°）、
    ↑↓=X・←→=Z・Ctrl+←→=Y、R/G/S で回転/移動/大きさ、1〜6 で視点。矢印の確定（undo 登録）は 400ms まとめ。
    Tab はフォーカスがボタン等にないときだけ奪う（ビューポートを押すとフォーカスを外す）。スライダー・セレクト上では各キーを奪わない。
  - 複数アングル一括書き出し（`batchZip(views,kinds)`）: 出力タブで向き（6視点）×種類（5画像＋キーポイント）を選んで1つの ZIP に。
    構図は視点ボタンと同じ `viewPose()`（操作中の人物が中心）、画面のカメラは動かさない。選択は localStorage `posedoll:batch`。
- v1.1（2026-10）ローカル版。three.js / JSZip を内蔵してオフライン化。保存庫をフォルダ保存（1件1 JSON）に、画像の保存先フォルダ指定を追加。
- v1.0（2026-10）claude.ai のアーティファクト版（クラウド保存）として確定。複数人物・体型・手指（DWPose 形式の手出力）・可動域制限・IK・
  腰移動時の足固定・小道具・参照画像・保存庫。アーティファクト版は https://claude.ai/artifact/WX599u9161WY4pVtTyNxR6 に残っている（以後は更新しない）。
- v0（2026-10）最初の版。人形の関節操作、9種のプリセット、人形 / OpenPose / 深度の書き出し。
