// 動作確認（Playwright + Chromium）。使い方: node src/smoke_test.js
// posedoll.html をオフラインで開き、主要機能を自動で確かめて結果を JSON で表示する。
// フォルダ保存はブラウザ内の仮想フォルダ（OPFS）で代用して確認する。
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const HTML = path.resolve(__dirname, '..', 'posedoll.html');

(async () => {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(fs.readFileSync(HTML)); }).listen(0);
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1300, height: 850 } });
  await ctx.route(u => !u.href.startsWith(url) && !/^(data|blob):/.test(u.href), r => r.abort());   // 外部通信なし
  await ctx.addInitScript(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('t', { create: true }); });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url); await p.waitForTimeout(2000);
  const res = await p.evaluate(async () => {
    const P = window.__pose, T = P.THREE, f = P.active(), out = {};
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // IK: 腕と脚が目標に届くか
    P.applyPreset('直立');
    const sh = f.J.shoulderL.getWorldPosition(new T.Vector3()), tgt = sh.clone().add(new T.Vector3(0.15, 0.1, 0.35));
    P.solveLimb(f, 'wristL', tgt, null); f.group.updateMatrixWorld(true);
    out.ikArmErr = f.J.wristL.getWorldPosition(new T.Vector3()).distanceTo(tgt) < 1e-6;
    // ひじ・ひざの IK（v1.4）: ひじは引いた方向へ向き（手は元の位置へ近づくよう曲がる）、ひざは足首を動かさずに向きが変わる
    { const w = n => f.J[n].getWorldPosition(new T.Vector3());
      P.applyPreset('直立'); f.group.updateMatrixWorld(true);
      const sp = w('shoulderL'), e0 = w('elbowL'), w0 = w('wristL'), tg = e0.clone().add(new T.Vector3(0, 0.1, 0.25));
      for (let i = 1; i <= 10; i++) { P.solveElbow(f, 'elbowL', e0.clone().lerp(tg, i / 10), w0); f.group.updateMatrixWorld(true); }
      const ang = w('elbowL').sub(sp).angleTo(tg.clone().sub(sp)) * 180 / Math.PI;
      P.applyPreset('座る'); f.group.updateMatrixWorld(true);
      const a0 = w('ankleL'), k0 = w('kneeL'); P.solvePole(f, 'kneeL', k0.clone().add(new T.Vector3(0.2, 0, 0)), f.J.ankleL.getWorldQuaternion(new T.Quaternion())); f.group.updateMatrixWorld(true);
      out.ikElbow = ang < 2; out.ikKnee = w('ankleL').distanceTo(a0) < 1e-4 && w('kneeL').x - k0.x > 0.1; }
    // 左右反転を2回で元に戻るか
    const p0 = f.getPose(), p2 = P.mirrorPose(P.mirrorPose(p0));
    out.mirror = JSON.stringify(p0.rot) === JSON.stringify(Object.fromEntries(Object.keys(p0.rot).map(k => [k, p2.rot[k]])));
    // プリセットが可動域の範囲内か
    out.presets = {};
    for (const n of ['直立', '歩く', '走る', '座る', 'しゃがむ', '手を振る', 'ジャンプ']) {
      P.setLimits(false); P.applyPreset(n); const a = JSON.stringify(f.getPose().rot);
      P.setLimits(true); for (const j in f.J) P.clampJoint(f, j); out.presets[n] = a === JSON.stringify(f.getPose().rot);
    }
    // 書き出し3種
    out.render = ['doll', 'openpose', 'depth', 'normal', 'lineart'].map(k => { const c = P.renderImage(k); return `${k}:${c.width}x${c.height}`; });
    // 保存庫: 保存 → 一覧 → 削除
    document.getElementById('libName').value = 'テスト'; document.getElementById('libSave').click();
    for (let i = 0; i < 80 && !document.querySelector('.lib-item'); i++) await wait(100);   // 遅い環境ではサムネイル作成に時間がかかる
    out.libSaved = document.querySelectorAll('.lib-item').length;
    { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('t'); let j = null;
      for await (const [n, h] of d.entries()) if (n.endsWith('.json')) { const t = await (await h.getFile()).text(); if (t) j = JSON.parse(t); }   // 空ファイル（日本語名の書き込み失敗の残り）は飛ばす
      out.libHasCam = !!(j && j.cam && j.cam.rel === 'hips' && j.cam.pos.length === 3); }
    const del = [...document.querySelectorAll('.lib-item button')].find(x => x.textContent === '削除'); del.click(); del.click(); await wait(800);
    out.libAfterDelete = document.querySelectorAll('.lib-item').length;
    out.zip = !!window.JSZip;
    // 複数アングル: 向き×種類＋シーンが ZIP に入り、画面の視点は変わらない。背面では左右が入れ替わる
    { P.applyPreset('直立'); P.setView('q'); const cBefore = JSON.stringify(P.getCam());
      const { z } = await P.batchZip(['front', 'back'], ['openpose', 'keypoints']);
      const names = Object.keys(z.files), kp = async v => JSON.parse(await z.file(names.find(n => n.includes(`_${v}_keypoints`))).async('string')).people[0].pose_keypoints_2d;
      const fr = await kp('front'), bk = await kp('back');
      out.batch = names.length === 5 && JSON.stringify(P.getCam()) === cBefore && fr[2*3] < fr[5*3] && bk[2*3] > bk[5*3];
      out.batchButton = document.getElementById('saveBatch').textContent; }
    // 言葉でポーズ（v1.5）: コードブロック・コメント・末尾カンマ入りの返事を読み、右側は鏡写し、手の形と浮かせも効く。壊れた返事は反映しない
    { P.applyPreset('直立'); P.setLimits(true);
      const r = P.applyLLM('はい:\n```json\n{"posedoll":"pose","name":"t","pose":{"right_shoulder":{"side":160,"front":10},"elbowR":{"bend":40}, // c\n "head":{"tilt":-8},"kneeL":{"bend":999},},"hands":{"R":"fist"},"lift":0.2}\n```');
      const rot = f.getPose().rot, minY = (() => { f.group.updateMatrixWorld(true); return f.J.ankleL.getWorldPosition(new T.Vector3()).y; })();
      const bad = P.applyLLM('ポーズは作れませんでした');
      out.llmPose = r.ok && r.clamped === 1 && JSON.stringify(rot.shoulderR) === '[-10,0,-160]' && rot.elbowR[0] === -40 && rot.head[2] === 8 && rot.kneeL[0] === 155
        && rot.fR_index2[2] > 90 && minY > 0.2 && !bad.ok && P.llmPrompt().includes('shoulderL'); }
    // ショートカット: Tab で関節送り、矢印で 1°/5°、R/G、数字キーで視点
    { const key = (key, o = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...o }));
      P.applyPreset('直立'); P.select(null); document.activeElement.blur && document.activeElement.blur();
      key('Tab'); const s1 = P.getSel()?.name; key('Tab'); const s2 = P.getSel()?.name; key('Tab', { shiftKey: true }); const s3 = P.getSel()?.name;
      P.select({ kind: 'joint', fig: f, name: 'neck' }); const x0 = f.J.neck.rotation.x;
      key('ArrowUp'); key('ArrowUp', { shiftKey: true }); const dx = Math.round((f.J.neck.rotation.x - x0) * 180 / Math.PI);
      const z0 = f.J.neck.rotation.z; key('ArrowLeft'); const dz = Math.round((f.J.neck.rotation.z - z0) * 180 / Math.PI);
      const y0 = f.J.neck.rotation.y; key('ArrowRight', { ctrlKey: true }); const dy = Math.round((f.J.neck.rotation.y - y0) * 180 / Math.PI);
      P.select({ kind: 'joint', fig: f, name: 'hips' }); key('g'); const mv = document.getElementById('modeMove').classList.contains('on'); key('r');
      const rt = document.getElementById('modeRot').classList.contains('on');
      const c0 = JSON.stringify(P.getCam().pos); key('3'); const c1 = JSON.stringify(P.getCam().pos); key('1');
      out.shortcuts = s1 === 'hips' && s2 === 'spine' && s3 === 'hips' && dx === 6 && dz === -1 && dy === 1 && mv && rt && c0 !== c1;
      P.select(null); await wait(500); }
    // OpenPose JSON: 18点×3 / 手21点×3、枠内の座標になっているか
    { P.applyPreset('直立'); P.setView('front'); const j = P.openposeJSON(), pp = j.people[0], b = pp.pose_keypoints_2d;
      const inside = [1, 2, 5, 8, 11].every(i => b[i*3+2] === 1 && b[i*3] > 0 && b[i*3] < j.canvas_width && b[i*3+1] > 0 && b[i*3+1] < j.canvas_height);
      out.keypoints = j.people.length === P.figures().length && b.length === 54 && pp.hand_left_keypoints_2d.length === 63 && pp.hand_right_keypoints_2d.length === 63 && inside
        && b[2*3] < b[5*3];   // 正面から見ると本人の右肩(2)は画面の左側
      const c = P.renderImage('openpose'), px = c.getContext('2d').getImageData(Math.round(b[3]), Math.round(b[4]), 1, 1).data;
      out.keypointsOnImage = px[0] + px[1] + px[2] > 100;   // 首の点の位置に絵が描かれている
      // 法線: 胸の正面はカメラ向き（青が強い）。線画: 黒地に白い線が少しある
      const nc = P.renderImage('normal').getContext('2d').getImageData(Math.round(b[3]), Math.round(b[4]) + 40, 1, 1).data;
      out.normalFacing = nc[2] > 200 && Math.abs(nc[0] - 128) < 60;
      const ld = P.renderImage('lineart').getContext('2d').getImageData(0, 0, j.canvas_width, j.canvas_height).data;
      let white = 0; for (let i = 0; i < ld.length; i += 4) if (ld[i] > 127) white++;
      out.lineartRatio = Math.round(white / (ld.length / 4) * 1000) / 1000;   // 0.005〜0.1 くらいが正常
    }
    // 人体の見た目（v1.3）: 既定は人体。肌は体＋左右の手の3つ。部品は見えないがクリック判定に使う。深度は姿勢どおりに描かれる
    { await wait(300); const sk = f.skin;
      out.look = P.getLook() === 'human' && !!sk && sk.meshes.length === 3 && sk.meshes.every(m => m.visible) && f.meshes.every(m => !m.visible);
      P.applyPreset('直立'); P.setView('front'); await wait(300);
      const ray = new T.Raycaster(), v = f.J.chest.getWorldPosition(new T.Vector3()).add(new T.Vector3(0, 0.1, 0)).project(P.camera());
      ray.setFromCamera(new T.Vector2(v.x, v.y), P.camera()); const hit = ray.intersectObjects(f.meshes, false)[0];
      out.pickSkin = hit?.object.userData.joint === 'chest';   // 見えない部品でもクリック判定に当たる
      P.applyPreset('Tポーズ'); const j = P.openposeJSON(), b = j.people[0].pose_keypoints_2d;
      const ex = Math.round((b[6*3] + b[7*3]) / 2), ey = Math.round((b[6*3+1] + b[7*3+1]) / 2);   // 左ひじと左手首の中間（T ポーズの前腕）
      out.depthPosed = P.renderImage('depth').getContext('2d').getImageData(ex, ey, 1, 1).data[0] > 30;
      f.setBody({ ...f.body, thick: 1.3 }); P.renderImage('depth'); out.skinRebuild = f.skin.key === JSON.stringify(f.body) && !f.skin.coarse;
      f.setBody({ ...f.body, thick: 1 });
      P.setLook('doll'); out.lookDoll = f.meshes.every(m => m.visible) && f.skin.meshes.every(m => !m.visible) && P.renderImage('depth').width > 0;
      P.setLook('human'); P.applyPreset('直立'); }
    // 真横の警告（v1.6）: 腰 -90°（真横）で警告、-70°（真横から 20°）と正面では出ない。出力タブの表示も切り替わる
    { const D = Math.PI / 180, warnAt = async deg => { P.applyPreset('直立'); f.J.hips.rotation.y = deg * D; P.setView('front'); await wait(120);
        return [P.sideness(f, P.camera()) < 0.3, !document.getElementById('opWarn').hidden]; };
      const s90 = await warnAt(-90), s70 = await warnAt(-70), s0 = await warnAt(0);
      out.sideWarn = s90.every(Boolean) && !s70.some(Boolean) && !s0.some(Boolean);
      P.applyPreset('直立'); }
    // 足先・顔の点（v1.6）: JSON に入り、画像にも描かれる。足先は3点（BODY_25 の色）と1点（Wan Animate の色）
    { const setOp = (feet, face) => { const sel = document.getElementById('opFeet'), cb = document.getElementById('opFace');
        sel.value = feet; cb.checked = face; sel.dispatchEvent(new Event('change')); cb.dispatchEvent(new Event('change')); };
      P.applyPreset('直立'); P.setView('front'); setOp('body25', true);
      const j = P.openposeJSON(), pp = j.people[0], ft = pp.foot_keypoints_2d, fc = pp.face_keypoints_2d, b = pp.pose_keypoints_2d;
      const c = P.renderImage('openpose').getContext('2d'), px = (x, y) => [...c.getImageData(Math.round(x), Math.round(y), 1, 1).data];
      const heelL = px(ft[2*3], ft[2*3+1]), heelR = px(ft[5*3], ft[5*3+1]);
      const nose = px(fc[30*3], fc[30*3+1]);
      out.feetFace = ft.length === 18 && fc.length === 204 && fc.filter((v, i) => i % 3 === 2 && v === 1).length === 68
        && ft[0] < ft[3] && ft[2*3+1] > b[13*3+1]   // 正面: 左足の親指側は小指側より内側（画面の左）、かかとは足首より下
        && fc[36*3] < fc[45*3] && fc[8*3+1] > fc[30*3+1]   // 右目の外側(36)は画面の左、あご先(8)は鼻(30)より下
        && heelL[2] > 200 && heelL[0] < 60 && heelR[1] > 200 && heelR[2] > 200 && heelR[0] < 60 && nose.every((v, i) => i === 3 || v > 200);
      P.setView('back'); out.faceBack = P.openposeJSON().people[0].face_keypoints_2d.filter((v, i) => i % 3 === 2 && v === 1).length;   // 背面では顔の点は見えない（0）
      P.setView('front'); setOp('toe', false);
      const j2 = P.openposeJSON().people[0], t = j2.foot_keypoints_2d, toe = [(t[0] + t[3]) / 2, (t[1] + t[4]) / 2];
      const tp = [...P.renderImage('openpose').getContext('2d').getImageData(Math.round(toe[0]), Math.round(toe[1]), 1, 1).data];
      out.feetToe = j2.face_keypoints_2d === null && tp[0] > 150 && tp[1] > 150 && tp[2] < 60;   // 左のつま先は (200,200,0)
      setOp('none', false); out.feetOff = !('foot_keypoints_2d' in P.openposeJSON().people[0]); }
    // 枠の中の配置（v1.6）: 右へ 25% ずらすと点が幅の 25% 右へ、大きさ 60% で首〜腰の長さが 0.6 倍。画面のカメラにも効き、シーン JSON に入る
    { P.applyPreset('直立'); P.setView('front'); const kp = () => P.openposeJSON().people[0].pose_keypoints_2d, W = P.openposeJSON().canvas_width;
      const a = kp(); P.setPlace(0.25, 0, 1); const b2 = kp(); P.setPlace(0, 0, 0.6); const c2 = kp();
      const len = k => Math.hypot(k[3] - (k[8*3] + k[11*3]) / 2, k[4] - (k[8*3+1] + k[11*3+1]) / 2);
      out.place = Math.abs(b2[3] - a[3] - 0.25 * W) < 1 && Math.abs(b2[4] - a[4]) < 1 && Math.abs(len(c2) / len(a) - 0.6) < 0.01
        && P.camera().view?.enabled === true && JSON.stringify(P.getCam().place) === '[0,0,0.6]';
      P.setPlace(0, 0, 1); out.placeReset = JSON.stringify(P.getCam().place) === '[0,0,1]' && Math.abs(P.camLens().center[1]) < 1e-9; }
    // カメラ: シーン JSON に入り、読み戻すと同じ視点・画角・サイズ・配置になるか
    const cam0 = { pos: [1.2, 1.6, 3.1], target: [0.1, 0.95, 0], fov: 40, frameFov: true, size: [1024, 1024], place: [0.1, -0.05, 1.2] };
    P.setCam(cam0); const sf = JSON.parse(JSON.stringify(P.sceneFile()));
    P.setCam({ pos: [0, 1, 5], target: [0, 1, 0], fov: 30, size: [832, 1216] });
    P.setCam(sf.cam); const c1 = P.getCam();
    out.camRoundtrip = JSON.stringify(c1) === JSON.stringify(cam0);
    out.camRender = (c => `${c.width}x${c.height}`)(P.renderImage('openpose'));
    out.camNotInUndo = !('cam' in P.getScene());
    P.setCam({ pos: [0, 1, 5], target: [0, 1, 0], fov: 30, size: [832, 1216] }); out.camOldFile = JSON.stringify(P.getCam().place) === '[0,0,1]';   // place の無い古いファイルは配置なしに戻る
    // v1.7 データ形式: シーン JSON の skeleton だけで全関節・キーポイントの位置が再現できるか。cam.lens だけで画面上の位置が再現できるか
    { P.applyPreset('手を振る'); const fg = P.active(); fg.setBody({ ...fg.body, height: 0.9, head: 1.2, arm: 1.1 }); fg.J.hips.rotation.set(0.1, 0.7, -0.05);
      fg.J.fL_index2.rotation.set(0, 0, -0.9); fg.J.fR_thumb1.rotation.set(0.3, 0.2, 0.4);
      P.setCam({ pos: [1.4, 1.5, 2.9], target: [0.1, 0.9, 0], fov: 35, frameFov: true, size: [1344, 768], place: [0.2, -0.1, 1.3] });
      P.setScene(JSON.parse(JSON.stringify(P.sceneFile())));   // 比べる相手は保存された値（角度 0.1°・位置 1mm に丸めたもの）
      const sf = JSON.parse(JSON.stringify(P.sceneFile())), fs = sf.figures[sf.active], sk = fs.skeleton, D = Math.PI / 180;
      const mat = (o, q, s) => new T.Matrix4().compose(new T.Vector3(...o), q, new T.Vector3(s, s, s));
      const qE = (d, ord) => new T.Quaternion().setFromEuler(new T.Euler(d[0] * D, d[1] * D, d[2] * D, ord));
      const G = mat(fs.pos, new T.Quaternion(), fs.body.height), M = {};
      for (const [n, nd] of Object.entries(sk.nodes)) {
        const off = n === 'hips' ? fs.pose.root : nd.offset, rot = nd.joint ? (fs.pose.rot[n] || [0, 0, 0]) : nd.rest;
        M[n] = (nd.parent ? M[nd.parent] : G).clone().multiply(mat(off, qE(rot, sk.euler), nd.scale || 1)); }
      const wp = (m, o) => new T.Vector3(...o).applyMatrix4(m);
      let err = 0; fg.group.updateMatrixWorld(true);
      for (const n of Object.keys(sk.nodes)) if (fg.J[n]) err = Math.max(err, wp(M[n], [0, 0, 0]).distanceTo(fg.J[n].getWorldPosition(new T.Vector3())));
      for (const [k, mk] of Object.entries(sk.marks)) if (fg.marks[k]) err = Math.max(err, wp(M[mk.parent], mk.offset).distanceTo(fg.marks[k].getWorldPosition(new T.Vector3())));
      const ft = fg.kpFoot(); ['L', 'R'].forEach((s, i) => ['bigtoe', 'smalltoe', 'heel'].forEach((k, j) => { err = Math.max(err, wp(M['ankle' + s], sk.marks[`${s}_${k}`].offset).distanceTo(ft[i * 3 + j])); }));
      out.skeletonErr = +err.toExponential(2); out.skeleton = err < 2e-5 && Object.keys(sk.nodes).length === 17 + 30 + 2 + 1;
      // lens: 保存された数値だけで作ったカメラで投影し、書き出しの OpenPose と比べる（画面の大きさは使わない）
      const c = sf.cam, L = c.lens, [W, H] = c.size, cam = new T.PerspectiveCamera(L.fovY, L.aspect, 0.05, 100);
      cam.position.fromArray(c.pos); cam.lookAt(new T.Vector3(...c.target)); cam.updateMatrixWorld();
      const proj = v => { const q = v.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix); return [((q.x + L.center[0]) + 1) / 2 * W, (1 - (q.y + L.center[1])) / 2 * H]; };
      P.setCam(c); const k = P.openposeJSON().people[sf.active].pose_keypoints_2d;
      const mine = proj(fg.J.wristR.getWorldPosition(new T.Vector3()));
      out.lensErrPx = +Math.hypot(mine[0] - k[4 * 3], mine[1] - k[4 * 3 + 1]).toFixed(3); out.lens = out.lensErrPx < 0.05;
      out.propParts = (P.addProp('chair'), JSON.parse(JSON.stringify(P.sceneFile())).props.slice(-1)[0].parts.length === 6);
      out.formatTag = sf.format === 'posedoll-scene' && sf.formatVersion === '2.1'; }
    P.setCam({ size: [832, 1216] });
    return out;
  });
  // 画面（ブラウザの窓）の大きさを変えても書き出しの構図が変わらないか（v1.7）
  { const k = () => p.evaluate(() => { const j = window.__pose.openposeJSON().people[0].pose_keypoints_2d; return [j[3], j[4], j[13 * 3], j[13 * 3 + 1]]; });
    const a = await k(); await p.setViewportSize({ width: 1700, height: 950 }); await p.waitForTimeout(400); const b2 = await k();
    await p.setViewportSize({ width: 1100, height: 1000 }); await p.waitForTimeout(400); const c2 = await k();
    res.viewportFree = [b2, c2].every(x => x.every((v, i) => Math.abs(v - a[i]) < 0.01)); }
  console.log(JSON.stringify({ ...res, errors: errs }, null, 1));
  await b.close(); srv.close();
})();
