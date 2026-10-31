// Blender 検証用のシーンと「正解」（全ノード・点のワールド座標と書き出し画像上のピクセル位置）を作る。
// 使い方: node tests/blender/make_cases.js （playwright が必要。posedoll.html をビルドしてから）
const { chromium } = require('playwright'); const fs=require('fs'), path=require('path');
const OUT=path.resolve(__dirname,'cases');
(async()=>{
  const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p=await b.newPage({viewport:{width:1300,height:850}});
  await p.goto('file://'+path.resolve(__dirname,'..','..','posedoll.html')); await p.waitForTimeout(1500);
  const cases=await p.evaluate(()=>{
    const P=window.__pose, T=P.THREE, out={};
    const rnd=(()=>{ let s=12345; return ()=>((s=(s*1103515245+12345)%2147483648)/2147483648); })();
    const reset=()=>{ const fs=P.figures(); P.setScene({v:2,figures:[{pos:[0,0,0],body:{},pose:{rot:{},root:[0,0.97,0]}}],props:[]}); P.setLimits(true); };
    const ref=()=>{ const sf=JSON.parse(JSON.stringify(P.sceneFile())); P.setScene(sf); P.setCam(sf.cam);   // 正解は保存された値から作る
      const cam=P.exportCam(), [W,H]=sf.cam.size, px=v=>{ const q=v.clone().project(cam); return [(q.x+1)/2*W,(1-q.y)/2*H]; };
      const figs=P.figures().map(f=>{ f.group.updateMatrixWorld(true); const sk=P.skeletonOf(f), nodes={}, marks={};
        const objOf=n=>n==='headGroup'?f.headGroup:(n.endsWith('_thumbBase')?f.J['f'+n[1]+'_thumb1'].parent:f.J[n]);
        for(const n of Object.keys(sk.nodes)){ const w=objOf(n).getWorldPosition(new T.Vector3()); nodes[n]={w:w.toArray(),px:px(w)}; }
        for(const [k,o] of Object.entries(f.marks)){ const w=o.getWorldPosition(new T.Vector3()); marks[k]={w:w.toArray(),px:px(w)}; }
        const ft=f.kpFoot(); ['L','R'].forEach((s,i)=>['bigtoe','smalltoe','heel'].forEach((k,j)=>{ const w=ft[i*3+j]; marks[`${s}_${k}`]={w:w.toArray(),px:px(w)}; }));
        const face=f.kpFace(cam).pts.map(w=>({w:w.toArray(),px:px(w)}));
        return {name:f.name,nodes,marks,face}; });
      return {scene:sf, ref:{figures:figs, op:P.openposeJSON()}}; };
    // 1. 標準体型・歩く・斜め
    reset(); P.applyPreset('歩く'); P.setCam({pos:[1.9,1.4,3.6],target:[0,0.9,0],fov:30,frameFov:true,size:[832,1216],place:[0,0,1]}); out.c1_walk=ref();
    // 2. 体型変更・手を振る・ピース・横長・枠の中の配置あり
    reset(); { const f=P.active(); f.setBody({height:.92,head:1.18,shoulder:.86,hipW:.95,torso:.95,arm:.97,leg:1.06,thick:.82}); P.applyPreset('手を振る');
      for(const s of ['L','R']) ['thumb','index','middle','ring','pinky'].forEach((n,i)=>P.setFinger(f,s,n,[.75,0,0,1,1][i])); P.setSpread(f,'R',16); P.commit(); }
    P.setCam({pos:[-1.2,1.5,2.6],target:[0,0.9,0],fov:35,frameFov:true,size:[1344,768],place:[0.25,-0.1,1.3]}); out.c2_wave=ref();
    // 3. 2人・子供体型で座る・小道具（回転・拡大あり）・俯瞰
    reset(); { const f2=P.addFigure?null:null; }
    { document.getElementById('figAdd').click(); const fs=P.figures(); const k=fs[1]; P.select(null);
      k.setBody({height:.68,head:1.38,shoulder:.85,hipW:.9,torso:.92,arm:.92,leg:.9,thick:.85}); k.group.position.set(1.0,0,0.2);
      P.setScene(JSON.parse(JSON.stringify(P.sceneFile()))); }
    P.addProp('chair'); P.addProp('pillar'); { const s=P.sceneFile(); s.props[0].pos=[1.0,0,0.05]; s.props[0].rot=[0,25,0]; s.props[1].pos=[-1,0,-0.6]; s.props[1].rot=[10,0,-15]; s.props[1].scl=[1.2,0.8,1.2];
      s.figures[1].pose.rot={hipL:[-90,0,4],hipR:[-90,0,-4],kneeL:[90,0,0],kneeR:[90,0,0],spine:[10,0,0]}; s.figures[1].pose.root=[0,0.62,0]; P.setScene(s); }
    P.setCam({pos:[2.5,3.2,4.2],target:[0.4,0.6,0],fov:40,frameFov:true,size:[1024,1024],place:[0,0,1]}); out.c3_two_props=ref();
    // 4. すべての関節を乱数でひねる（XZY の順番の確認。可動域は外す）・腰も回す
    reset(); P.setLimits(false); { const s=P.sceneFile(), rot={}; const names=Object.keys(s.figures[0].skeleton.nodes).filter(n=>s.figures[0].skeleton.nodes[n].joint);
      for(const n of names) rot[n]=[0,1,2].map(()=>Math.round((rnd()*120-60)*10)/10);
      s.figures[0].pose.rot=rot; s.figures[0].pose.root=[0.2,1.0,-0.1]; s.figures[0].pos=[0.3,0,0.4]; s.figures[0].body.height=1.07; P.setScene(s); }
    P.setCam({pos:[0.8,0.6,3.0],target:[0.3,1.0,0.3],fov:45,frameFov:true,size:[896,1152],place:[-0.15,0.2,0.8]}); out.c4_random=ref();
    return out;
  });
  for(const [k,v] of Object.entries(cases)){ fs.writeFileSync(path.join(OUT,k+'.scene.json'),JSON.stringify(v.scene,null,1)); fs.writeFileSync(path.join(OUT,k+'.ref.json'),JSON.stringify(v.ref)); }
  console.log(Object.keys(cases).map(k=>`${k}: figs=${cases[k].scene.figures.length} props=${cases[k].scene.props.length} size=${cases[k].scene.cam.size}`).join('\n'));
  await b.close();
})();
