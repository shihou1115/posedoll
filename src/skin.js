// 人体の見た目: 球・円錐の距離場をなめらかに溶かし合わせ、1枚の肌（surface nets）にして骨の重みを付ける。
// three.js に依存しない計算だけのモジュール（座標はすべて人形グループのローカル、バインド姿勢）。
// prim: {t:'cone',a,b,ra,rb} | {t:'ell',c,R(3x3 行優先・ローカル→親),r} | {t:'box',c,R,he,rr}
//       共通 {k:溶かし幅, bone:骨番号, sel:選択用の関節番号, ghost:重み専用(形には入れない)}

function sdCone(p, q){
  const ax = q.a[0], ay = q.a[1], az = q.a[2], bx = q.b[0]-ax, by = q.b[1]-ay, bz = q.b[2]-az;
  const l2 = bx*bx+by*by+bz*bz, rr = q.ra-q.rb, a2 = l2-rr*rr, il2 = 1/l2;
  const px = p[0]-ax, py = p[1]-ay, pz = p[2]-az, y = px*bx+py*by+pz*bz, z = y-l2;
  const xx = px*l2-bx*y, xy = py*l2-by*y, xz = pz*l2-bz*y, x2 = xx*xx+xy*xy+xz*xz, y2 = y*y*l2, z2 = z*z*l2;
  const k = Math.sign(rr)*rr*rr*x2;
  if(Math.sign(z)*a2*z2 > k) return Math.sqrt(x2+z2)*il2-q.rb;
  if(Math.sign(y)*a2*y2 < k) return Math.sqrt(x2+y2)*il2-q.ra;
  return (Math.sqrt(x2*a2*il2)+y*rr)*il2-q.ra;
}
function sdEll(p, q){   // R は回転のみ。ローカル = R^T (p - c)
  const R = q.R, dx = p[0]-q.c[0], dy = p[1]-q.c[1], dz = p[2]-q.c[2], r = q.r;
  const ax = (R[0]*dx+R[3]*dy+R[6]*dz)/r[0], ay = (R[1]*dx+R[4]*dy+R[7]*dz)/r[1], az = (R[2]*dx+R[5]*dy+R[8]*dz)/r[2];
  const k0 = Math.sqrt(ax*ax+ay*ay+az*az), bx = ax/r[0], by = ay/r[1], bz = az/r[2], k1 = Math.sqrt(bx*bx+by*by+bz*bz);
  return k1 < 1e-9 ? -Math.min(r[0], r[1], r[2]) : k0*(k0-1)/k1;
}
function sdBox(p, q){
  const R = q.R, dx = p[0]-q.c[0], dy = p[1]-q.c[1], dz = p[2]-q.c[2], h = q.he;
  const x = Math.abs(R[0]*dx+R[3]*dy+R[6]*dz)-h[0], y = Math.abs(R[1]*dx+R[4]*dy+R[7]*dz)-h[1], z = Math.abs(R[2]*dx+R[5]*dy+R[8]*dz)-h[2];
  const mx = Math.max(x,0), my = Math.max(y,0), mz = Math.max(z,0);
  return Math.sqrt(mx*mx+my*my+mz*mz)+Math.min(Math.max(x,y,z),0)-q.rr;
}
export const sdf = (p, q) => q.t === 'cone' ? sdCone(p, q) : q.t === 'ell' ? sdEll(p, q) : sdBox(p, q);

function aabb(q){
  let lo, hi;
  if(q.t === 'cone'){ const r = Math.max(q.ra, q.rb); lo = [0,1,2].map(i => Math.min(q.a[i], q.b[i])-r); hi = [0,1,2].map(i => Math.max(q.a[i], q.b[i])+r); }
  else {
    const e = q.t === 'ell' ? q.r : q.he.map(v => v+q.rr), R = q.R;
    const ext = [0,1,2].map(i => Math.abs(R[i*3])*e[0]+Math.abs(R[i*3+1])*e[1]+Math.abs(R[i*3+2])*e[2]);
    lo = q.c.map((v,i) => v-ext[i]); hi = q.c.map((v,i) => v+ext[i]);
  }
  return [lo, hi];
}

// 距離場をグリッドに作る（各形の外接箱の中だけ計算。なめらかな最小は |a-b|>k なら厳密に min なので結果は全体計算と同じ）。
// まず 4 倍の粗いグリッドで計算し、面から遠いブロックは細かい計算を省く。
function fill(prims, boxes, lo, n, h, F, blk, bn, deep){
  const nx = n[0], nxy = n[0]*n[1], p = [0,0,0];
  prims.forEach((q, qi) => {
    const k = q.k, [a, b] = boxes[qi];
    const i0 = [0,1,2].map(i => Math.max(0, Math.floor((a[i]-k-lo[i])/h))), i1 = [0,1,2].map(i => Math.min(n[i]-1, Math.ceil((b[i]+k-lo[i])/h)));
    for(let z = i0[2]; z <= i1[2]; z++){ p[2] = lo[2]+z*h;
      for(let y = i0[1]; y <= i1[1]; y++){ p[1] = lo[1]+y*h; let idx = z*nxy+y*nx+i0[0];
        const brow = blk ? ((z>>2)*bn[1]+(y>>2))*bn[0] : 0;
        for(let x = i0[0]; x <= i1[0]; x++, idx++){
          const f = F[idx];
          if(f < deep || (blk && !blk[brow+(x>>2)])) continue;   // 深い内側は符号だけ分かればよい
          p[0] = lo[0]+x*h;
          const d = sdf(p, q), m = Math.max(k-Math.abs(f-d), 0)/k;
          F[idx] = Math.min(f, d)-m*m*k*0.25;
        } } }
  });
}
function field(prims, h){
  const boxes = prims.map(aabb), pad = h*4+Math.max(...prims.map(q => q.k));
  const lo = [0,1,2].map(i => Math.min(...boxes.map(b => b[0][i]))-pad), hi = [0,1,2].map(i => Math.max(...boxes.map(b => b[1][i]))+pad);
  const bn = [0,1,2].map(i => Math.ceil((hi[i]-lo[i])/(h*4))+1), n = bn.map(v => (v-1)*4+1);
  const C = new Float32Array(bn[0]*bn[1]*bn[2]).fill(1);
  fill(prims, boxes, lo, bn, h*4, C, null, null, -h*48);
  const blk = new Uint8Array(bn[0]*bn[1]*bn[2]), far = h*10, cx = bn[0], cxy = bn[0]*bn[1];
  for(let z = 0; z < bn[2]-1; z++) for(let y = 0; y < bn[1]-1; y++) for(let x = 0; x < bn[0]-1; x++){
    const i = z*cxy+y*cx+x;
    for(const o of [0, 1, cx, cx+1, cxy, cxy+1, cxy+cx, cxy+cx+1]) if(Math.abs(C[i+o]) < far){ blk[(z*bn[1]+y)*bn[0]+x] = 1; break; }
  }
  const nx = n[0], nxy = n[0]*n[1], F = new Float32Array(n[0]*n[1]*n[2]);
  for(let z = 0; z < n[2]; z++) for(let y = 0; y < n[1]; y++) for(let x = 0, i = z*nxy+y*nx; x < nx; x++, i++){   // 遠いブロックは粗い値（符号が正しい）
    const bx = Math.min(x>>2, bn[0]-1), by = Math.min(y>>2, bn[1]-1), bz = Math.min(z>>2, bn[2]-1);
    F[i] = blk[(bz*bn[1]+by)*bn[0]+bx] ? 1 : C[bz*cxy+by*cx+bx];
  }
  fill(prims, boxes, lo, n, h, F, blk, bn, -h*4);
  return {F, n, lo, h};
}

// surface nets: 符号の変わるセルに1頂点（辺の交点の平均）、符号の変わる辺ごとに四角形
const EDGES = [0,1, 2,3, 4,5, 6,7, 0,2, 1,3, 4,6, 5,7, 0,4, 1,5, 2,6, 3,7];
function mesh({F, n, lo, h}){
  const [nx, ny, nz] = n, nxy = nx*ny, cell = new Int32Array(nx*ny*nz).fill(-1), near = h*3.5;
  const off = [0, 1, nx, nx+1, nxy, nxy+1, nxy+nx, nxy+nx+1], v = new Float32Array(8);
  let pos = new Float32Array(1<<16), nor = new Float32Array(1<<16), nv = 0;
  for(let z = 1; z < nz-2; z++) for(let y = 1; y < ny-2; y++) for(let x = 1, i = z*nxy+y*nx+1; x < nx-2; x++, i++){
    if(F[i] > near || F[i] < -near) continue;   // 距離場なのでセルの対角より遠ければ面は通らない
    let mask = 0;
    for(let c = 0; c < 8; c++){ v[c] = F[i+off[c]]; if(v[c] < 0) mask |= 1<<c; }
    if(mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, gx = 0, gy = 0, gz = 0, cnt = 0;
    for(let e = 0; e < 24; e += 2){
      const c0 = EDGES[e], c1 = EDGES[e+1], v0 = v[c0], v1 = v[c1];
      if((v0 < 0) === (v1 < 0)) continue;
      const t = v0/(v0-v1), u = 1-t, j0 = i+off[c0], j1 = i+off[c1];
      sx += (c0&1)*u+(c1&1)*t; sy += ((c0>>1)&1)*u+((c1>>1)&1)*t; sz += ((c0>>2)&1)*u+((c1>>2)&1)*t; cnt++;
      gx += u*(F[j0+1]-F[j0-1])+t*(F[j1+1]-F[j1-1]);
      gy += u*(F[j0+nx]-F[j0-nx])+t*(F[j1+nx]-F[j1-nx]);
      gz += u*(F[j0+nxy]-F[j0-nxy])+t*(F[j1+nxy]-F[j1-nxy]);
    }
    if(nv*3+3 > pos.length){ const p2 = new Float32Array(pos.length*2), n2 = new Float32Array(pos.length*2); p2.set(pos); n2.set(nor); pos = p2; nor = n2; }
    const gl = Math.hypot(gx, gy, gz) || 1, o = nv*3;
    pos[o] = lo[0]+(x+sx/cnt)*h; pos[o+1] = lo[1]+(y+sy/cnt)*h; pos[o+2] = lo[2]+(z+sz/cnt)*h;
    nor[o] = gx/gl; nor[o+1] = gy/gl; nor[o+2] = gz/gl;
    cell[i] = nv++;
  }
  const idx = nv > 65535 ? new Uint32Array(nv*12) : new Uint16Array(nv*12); let ni = 0;
  const quad = (a, b, c, d, flip) => {
    if(a < 0 || b < 0 || c < 0 || d < 0) return;
    if(ni+6 > idx.length) return;
    if(flip){ idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
    else { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
  };
  for(let z = 2; z < nz-2; z++) for(let y = 2; y < ny-2; y++) for(let x = 2, i = z*nxy+y*nx+2; x < nx-2; x++, i++){
    const f = F[i]; if(f > near || f < -near) continue;
    const inside = f < 0;
    if(inside !== (F[i+1] < 0)) quad(cell[i], cell[i-nx], cell[i-nx-nxy], cell[i-nxy], !inside);
    if(inside !== (F[i+nx] < 0)) quad(cell[i], cell[i-nxy], cell[i-1-nxy], cell[i-1], !inside);
    if(inside !== (F[i+nxy] < 0)) quad(cell[i], cell[i-1], cell[i-1-nx], cell[i-nx], !inside);
  }
  return {pos: pos.slice(0, nv*3), nor: nor.slice(0, nv*3), idx: idx.slice(0, ni)};
}

// 骨の重み: いちばん近い形の骨と、その親・子の骨だけに、形までの距離の差で配分する（左右の脚どうしなどが混ざらない）
function weights(pos, prims, parent, sigma){
  const nv = pos.length/3, si = new Uint16Array(nv*4), sw = new Float32Array(nv*4), sel = new Float32Array(nv);
  const nb = parent.length, wb = new Float32Array(nb), p = [0,0,0], d = new Float32Array(prims.length);
  const boxes = prims.map(aabb), near = 0.08;
  for(let v = 0; v < nv; v++){
    p[0] = pos[v*3]; p[1] = pos[v*3+1]; p[2] = pos[v*3+2];
    let dm = Infinity, qm = 0;
    prims.forEach((q, i) => {
      const [a, b] = boxes[i];
      d[i] = (p[0] < a[0]-near || p[0] > b[0]+near || p[1] < a[1]-near || p[1] > b[1]+near || p[2] < a[2]-near || p[2] > b[2]+near) ? Infinity : sdf(p, q);
      if(d[i] < dm){ dm = d[i]; qm = i; }
    });
    const bm = prims[qm].bone; sel[v] = prims[qm].sel; wb.fill(0);
    prims.forEach((q, i) => {
      const bn = q.bone; if(d[i] === Infinity || !(bn === bm || parent[bn] === bm || parent[bm] === bn)) return;
      wb[bn] = Math.max(wb[bn], Math.exp(-(d[i]-dm)/sigma));
    });
    const top = []; for(let b = 0; b < nb; b++) if(wb[b] > 1e-3) top.push(b);
    top.sort((a, b) => wb[b]-wb[a]); top.length = Math.min(4, top.length);
    const s = top.reduce((t, b) => t+wb[b], 0);
    top.forEach((b, j) => { si[v*4+j] = b; sw[v*4+j] = wb[b]/s; });
  }
  return {si, sw, sel};
}

// まとめ: parts=[{prims, h, sigma}] → 部分ごとのメッシュ（位置・法線・面・骨番号・重み・選択用の関節番号）
export function buildSkin(parts, parent){
  return parts.map(({prims, h, sigma}) => {
    const m = mesh(field(prims.filter(q => !q.ghost), h));
    return {...m, ...weights(m.pos, prims, parent, sigma)};
  });
}
