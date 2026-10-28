import * as THREE from 'three';
import { OrbitControls } from 'three-orbit';
import { TransformControls } from 'three-transform';
import { buildSkin } from './skin.js';
import { PROMPT as LLM_PROMPT, parseLoose, llmToPose } from './llmpose.js';

const $ = id => document.getElementById(id);
const D2R = Math.PI/180, R2D = 180/Math.PI;
const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
const V3 = ()=>new THREE.Vector3();
const wpos = o=>o.getWorldPosition(new THREE.Vector3());
const wquat = o=>o.getWorldQuaternion(new THREE.Quaternion());
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

// state
let figures=[], active=null, props=[], sel=null, dirty=true;
let ikOn=false, limitsOn=true, moveMode=false, propMode='translate', handSide='B';
let undoStack=[], redoStack=[], dragCtx=null, figNo=0;
let vw=1, vh=1, look=lsGet('posedoll:look')==='doll'?'doll':'human', bodyEditAt=0;
const stage=$('stage');

// renderer / scene
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setClearColor(0x000000,0);
stage.insertBefore(renderer.domElement,$('refImg').nextSibling);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(30,1,0.05,100);
const orbit=new OrbitControls(camera,renderer.domElement);
orbit.enableDamping=true; orbit.dampingFactor=0.12; orbit.target.set(0,0.9,0);
scene.add(new THREE.HemisphereLight(0xffffff,0x8a7a66,1.6));
const key=new THREE.DirectionalLight(0xffffff,1.6); key.position.set(2.5,4,3); scene.add(key);
const rim=new THREE.DirectionalLight(0xffffff,0.6); rim.position.set(-3,2,-2); scene.add(rim);
const helpers=new THREE.Group(); scene.add(helpers);
const grid=new THREE.GridHelper(6,24,0x9a8f80,0xbdb4a7); grid.material.transparent=true; grid.material.opacity=.5; grid.position.y=0.001; helpers.add(grid);
const figRoot=new THREE.Group(); scene.add(figRoot);
const propRoot=new THREE.Group(); scene.add(propRoot);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(12,12),new THREE.MeshStandardMaterial({color:0xcdc6bb,roughness:.95}));
floor.rotation.x=-Math.PI/2; floor.visible=false; propRoot.add(floor);
const ikGroup=new THREE.Group(); ikGroup.visible=false; scene.add(ikGroup);

const SPH=new THREE.SphereGeometry(1,32,20);
const BOX=new THREE.BoxGeometry(1,1,1);
const CYL=new THREE.CylinderGeometry(1,1,1,32);
const CAPS={}; const capGeo=(r,l)=>CAPS[r+'_'+l]||(CAPS[r+'_'+l]=new THREE.CapsuleGeometry(r,l,6,14));
const matSel=new THREE.MeshStandardMaterial({color:0x3f6ee0,roughness:.45,emissive:0x0d2470,emissiveIntensity:.35});
const matProp=new THREE.MeshStandardMaterial({color:0xaab3bf,roughness:.8});
const matPropSel=new THREE.MeshStandardMaterial({color:0x7f9be6,roughness:.6,emissive:0x0d2470,emissiveIntensity:.2});
const matHandle=new THREE.MeshBasicMaterial({color:0x2f5bd3,transparent:true,opacity:.85,depthTest:false});
const HANDLE_GEO=new THREE.SphereGeometry(0.035,20,14);
// skin material: the selected joint's area is tinted blue (aSel = joint index per vertex)
function skinMaterial(col){
  const m=new THREE.MeshStandardMaterial({color:col,roughness:.6}), u={value:-1}; m.userData.uSel=u;
  m.onBeforeCompile=sh=>{
    sh.uniforms.uSel=u;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float aSel; uniform float uSel; varying float vSel;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvSel=step(abs(aSel-uSel),0.5);');
    sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nvarying float vSel;')
      .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.25,0.43,0.88),vSel*0.8);');
  };
  m.customProgramCacheKey=()=>'posedoll-skin'; return m;
}
const FIG_COLORS=[0xd8b48a,0xb7c6d9,0xd9b0b0,0xb9d3ae,0xd6c99a,0xc4b5dc];

// skeleton definitions
const BODY_JOINTS=['hips','spine','chest','neck','head','shoulderL','elbowL','wristL','shoulderR','elbowR','wristR','hipL','kneeL','ankleL','hipR','kneeR','ankleR'];
const FINGERS=['thumb','index','middle','ring','pinky'];
const FN_JA={thumb:'親指',index:'人差し指',middle:'中指',ring:'薬指',pinky:'小指'};
const fj=(s,f,k)=>`f${s}_${f}${k}`;
const FINGER_JOINTS=s=>FINGERS.flatMap(f=>[1,2,3].map(k=>fj(s,f,k)));
const ALL_JOINTS=[...BODY_JOINTS,...FINGER_JOINTS('L'),...FINGER_JOINTS('R')];
const JLABEL={hips:'腰（全体）',spine:'おなか',chest:'胸',neck:'首',head:'頭',
  shoulderR:'右肩',elbowR:'右ひじ',wristR:'右手首',shoulderL:'左肩',elbowL:'左ひじ',wristL:'左手首',
  hipR:'右もも',kneeR:'右ひざ',ankleR:'右足首',hipL:'左もも',kneeL:'左ひざ',ankleL:'左足首'};
function jointLabel(n){
  if(JLABEL[n]) return JLABEL[n];
  const m=n.match(/^f([LR])_(\w+?)(\d)$/); if(!m) return n;
  const parts=m[2]==='thumb'?['付け根','中間','先']:['付け根','第2関節','第1関節'];
  return `${m[1]==='L'?'左':'右'}${FN_JA[m[2]]}・${parts[m[3]-1]}`;
}
const otherSide=n=>n.startsWith('f')?'f'+(n[1]==='L'?'R':'L')+n.slice(2):(/[LR]$/.test(n)?n.slice(0,-1)+(n.endsWith('L')?'R':'L'):n);
const sideOf=n=>n.startsWith('f')?n[1]:(/[LR]$/.test(n)?n.slice(-1):null);

// joint limits (degrees, person's left side; right side mirrored)
const LIM={
  spine:[[-30,50],[-40,40],[-30,30]], chest:[[-25,40],[-35,35],[-25,25]], neck:[[-45,55],[-60,60],[-35,35]], head:[[-35,35],[-45,45],[-25,25]],
  shoulder:[[-180,60],[-95,95],[-30,180]], elbow:[[-150,0],[-90,90],[-5,5]], wrist:[[-30,30],[-25,25],[-80,75]],
  hip:[[-130,35],[-50,50],[-30,75]], knee:[[0,155],[-15,15],[-5,5]], ankle:[[-45,50],[-30,30],[-25,25]],
  f1:[[-25,25],[-8,8],[-95,15]], f2:[[-3,3],[-3,3],[-115,5]], f3:[[-3,3],[-3,3],[-90,5]],
  t1:[[-50,50],[-45,45],[-60,35]], t2:[[-20,20],[-20,20],[-70,15]], t3:[[-10,10],[-10,10],[-90,20]],
};
function limitsFor(n){
  let side=sideOf(n), key=n;
  if(n.startsWith('f')){ const m=n.match(/^f[LR]_(\w+?)(\d)$/); key=(m[1]==='thumb'?'t':'f')+m[2]; }
  else if(side) key=n.slice(0,-1);
  const L=LIM[key]; if(!L) return null;
  return side==='R'?[L[0],[-L[1][1],-L[1][0]],[-L[2][1],-L[2][0]]]:L;
}
function clampJoint(fig,n){
  if(!limitsOn) return; const L=limitsFor(n); if(!L) return;
  const r=fig.J[n].rotation;
  r.set(clamp(r.x,L[0][0]*D2R,L[0][1]*D2R),clamp(r.y,L[1][0]*D2R,L[1][1]*D2R),clamp(r.z,L[2][0]*D2R,L[2][1]*D2R));
}

// body proportions
const BODY_DEF={height:1,head:1,shoulder:1,hipW:1,torso:1,arm:1,leg:1,thick:1};
const BP_LABEL={height:'身長',head:'頭の大きさ',shoulder:'肩幅',hipW:'腰幅',torso:'胴の長さ',arm:'腕の長さ',leg:'脚の長さ',thick:'太さ'};
const BP_RANGE={height:[.5,1.3],head:[.7,1.7],shoulder:[.7,1.4],hipW:[.7,1.4],torso:[.75,1.3],arm:[.75,1.3],leg:[.7,1.35],thick:[.6,1.6]};
const BODY_PRESETS={
  '標準':{},
  'アニメ少女':{height:.92,head:1.18,shoulder:.86,hipW:.95,torso:.95,arm:.97,leg:1.06,thick:.82},
  'アニメ少年':{height:.95,head:1.12,shoulder:.95,hipW:.9,torso:.97,arm:1,leg:1.05,thick:.88},
  '子供':{height:.68,head:1.38,shoulder:.85,hipW:.9,torso:.92,arm:.92,leg:.9,thick:.85},
  'モデル体型':{height:1.02,head:.9,shoulder:.98,hipW:.95,torso:1,arm:1.03,leg:1.12,thick:.88},
  'がっしり':{height:1.04,head:.95,shoulder:1.18,hipW:1.05,torso:1.03,arm:1.02,leg:1,thick:1.25},
};
const F={
  one:()=>[1,1,1], torsoY:B=>[1,B.torso,1], shJ:B=>[B.shoulder*(.75+.25*B.thick),B.torso,1], armY:B=>[1,B.arm,1],
  hipJ:B=>[B.hipW*(.8+.2*B.thick),1,1], legY:B=>[1,B.leg,1], th:B=>[B.thick,B.thick,B.thick],
  pelvis:B=>[B.hipW*B.thick,1,B.thick], belly:B=>[(B.shoulder+B.hipW)/2*B.thick,B.torso,B.thick],
  chest:B=>[B.shoulder*B.thick,B.torso,B.thick], neck:B=>[B.thick,B.torso,B.thick],
  armSeg:B=>[B.thick,B.arm,B.thick], legSeg:B=>[B.thick,B.leg,B.thick], foot:B=>[B.thick,1,1],
};

// human look: shapes per bone (local coords of the person's left side; the right side mirrors x). t: c=round cone, e=ellipsoid, b=round box
// g = how body proportions scale it (see SK_F), k = blend width, at = frame joint when it differs from the owning bone, ghost = weights only
const ANAT=[
  {j:'hips',t:'e',c:[0,0,-0.005],r:[0.125,0.095,0.09],g:'pel',k:.05},
  {j:'hips',t:'e',c:[0.05,-0.045,-0.04],r:[0.066,0.08,0.064],g:'pel',k:.04},
  {j:'hips',t:'e',c:[0,0.05,0.025],r:[0.115,0.085,0.07],g:'pel',k:.05},
  {j:'spine',t:'e',c:[0,0.08,0.006],r:[0.112,0.13,0.08],g:'bel',k:.06},
  {j:'chest',t:'e',c:[0,0.1,-0.01],r:[0.128,0.16,0.093],g:'chs',k:.06},
  {j:'chest',t:'e',c:[0.055,0.128,0.04],r:[0.065,0.05,0.045],g:'chs',k:.04},
  {j:'chest',t:'e',c:[0.06,0.19,-0.022],r:[0.078,0.04,0.05],g:'chs',k:.045},
  {j:'neck',t:'c',a:[0,-0.03,-0.005],b:[0,0.1,0.005],ra:0.05,rb:0.043,g:'nek',k:.035},
  {j:'head',t:'e',c:[0,0.118,-0.008],r:[0.084,0.104,0.1],g:'hed',k:.03},
  {j:'head',t:'e',c:[0,0.062,0.028],r:[0.064,0.068,0.07],g:'hed',k:.03},
  {j:'head',t:'e',c:[0,0.032,0.058],r:[0.03,0.024,0.028],g:'hed',k:.02},
  {j:'head',t:'e',c:[0,0.086,0.097],r:[0.011,0.02,0.014],g:'hed',k:.012},
  {j:'head',t:'e',c:[0.081,0.093,-0.008],r:[0.009,0.022,0.014],g:'hed',k:.008},
  {j:'shoulder',t:'e',c:[0.004,-0.04,0],r:[0.047,0.075,0.052],g:'arm',k:.045},
  {j:'shoulder',t:'c',a:[0,-0.03,0],b:[0,-0.27,0],ra:0.04,rb:0.032,g:'arm',k:.035},
  {j:'shoulder',t:'e',c:[0,-0.145,0.01],r:[0.034,0.08,0.035],g:'arm',k:.03},
  {j:'elbow',t:'c',a:[0,0,0],b:[0,-0.235,0],ra:0.034,rb:0.019,g:'arm',k:.025},
  {j:'elbow',at:'wrist',t:'e',c:[0,0.024,0.001],r:[0.014,0.034,0.021],g:'arm',k:.02},
  {j:'elbow',t:'e',c:[0,-0.07,0.002],r:[0.038,0.085,0.035],g:'arm',k:.03},
  {j:'wrist',t:'e',c:[0,-0.048,0.002],r:[0.02,0.05,0.042],g:'hnd',k:.01,ghost:1},
  {j:'hip',t:'c',a:[0,0,0],b:[0,-0.4,0],ra:0.075,rb:0.046,g:'leg',k:.045},
  {j:'hip',t:'e',c:[0.004,-0.17,0.016],r:[0.064,0.15,0.064],g:'leg',k:.035},
  {j:'knee',t:'c',a:[0,0,0],b:[0,-0.4,0],ra:0.047,rb:0.03,g:'leg',k:.03},
  {j:'knee',t:'e',c:[0,-0.12,-0.022],r:[0.046,0.11,0.046],g:'leg',k:.035},
  {j:'knee',t:'e',c:[0,-0.005,0.032],r:[0.03,0.034,0.02],g:'leg',k:.02},
  {j:'ankle',t:'c',a:[0,0.035,0],b:[0,-0.025,0.004],ra:0.031,rb:0.033,g:'fot',k:.025},
  {j:'ankle',t:'e',c:[0,-0.035,-0.012],r:[0.034,0.033,0.045],g:'fot',k:.02},
  {j:'ankle',t:'e',c:[0.002,-0.043,0.06],r:[0.043,0.025,0.095],g:'fot',k:.025},
  {j:'ankle',t:'e',c:[0.004,-0.05,0.138],r:[0.04,0.018,0.04],g:'fot',k:.02},
];
// hand (separate, finer mesh): wrist, palm, thenar and a stub hidden inside the forearm; fingers are added in skinPrims()
const ANAT_HAND=[
  {j:'wrist',t:'c',a:[0,0.006,0],b:[0,-0.026,0.001],ra:0.012,rb:0.016,g:'hnd',k:.012},
  {j:'wrist',t:'b',c:[0,-0.058,0.001],he:[0.002,0.022,0.019],rr:0.017,g:'hnd',k:.016},
  {j:'elbow',at:'wrist',t:'e',c:[0,0.026,0.001],r:[0.011,0.03,0.017],g:'arm',k:.01},
];
const SK_F={
  pel:B=>{ const w=B.hipW*B.thick; return [[w,1,B.thick],[w,(1+B.thick)/2,B.thick]]; },
  bel:B=>{ const w=(B.shoulder+B.hipW)/2*B.thick; return [[w,B.torso,B.thick],[w,B.torso,B.thick]]; },
  chs:B=>{ const w=B.shoulder*B.thick; return [[w,B.torso,B.thick],[w,B.torso,B.thick]]; },
  nek:B=>[[1,B.torso,1],[B.thick,B.torso,B.thick]],
  hed:B=>[[1,1,1],[1,1,1]],
  arm:B=>[[1,B.arm,1],[B.thick,B.arm,B.thick]],
  leg:B=>[[1,B.leg,1],[B.thick,B.leg,B.thick]],
  fot:B=>[[1,1,1],[B.thick,1,(3+B.thick)/4]],
  hnd:B=>[[1,1,1],[1,1,1]],
};
const SKIN_Q={body:[0.0065,0.015],hand:[0.0022,0.005]};   // grid size (m), weight blend (m)

// Figure
class Figure{
  constructor(name){
    this.name=name; this.group=new THREE.Group(); figRoot.add(this.group);
    const col=new THREE.Color(FIG_COLORS[figures.length%FIG_COLORS.length]);
    this.matWood=new THREE.MeshStandardMaterial({color:col,roughness:.62});
    this.matJoint=new THREE.MeshStandardMaterial({color:col.clone().multiplyScalar(.8),roughness:.55});
    this.matSkin=skinMaterial(col);
    this.J={}; this.jf={}; this.parts=[]; this.meshes=[]; this.marks={}; this.body={...BODY_DEF}; this.handles=null; this.fdef={}; this.skin=null;
    this.build(); this.applyBody(); this.showLook();
  }
  joint(name,parent,pos,f){
    const o=new THREE.Object3D(); o.name=name; o.rotation.order='XZY'; o.position.set(...pos);
    (typeof parent==='string'?this.J[parent]:(parent||this.group)).add(o);
    this.J[name]=o; this.jf[name]={base:new THREE.Vector3(...pos),f}; return o;
  }
  add(owner,parent,geo,pos,scl,fp,fs,mat){
    const m=new THREE.Mesh(geo,mat||this.matWood); m.userData={fig:this,joint:owner,base:m.material};
    (typeof parent==='string'?this.J[parent]:parent).add(m);
    this.parts.push({m,p:new THREE.Vector3(...pos),s:new THREE.Vector3(...scl),fp:fp||F.one,fs:fs||F.one}); this.meshes.push(m); return m;
  }
  ell(owner,parent,pos,scl,fp,fs,mat){ return this.add(owner,parent,SPH,pos,scl,fp,fs,mat); }
  cap(owner,parent,r,len,pos,fp,fs){ return this.add(owner,parent,capGeo(r,len),pos,[1,1,1],fp,fs); }
  ball(owner,r){ return this.ell(owner,owner,[0,0,0],[r,r,r],F.one,F.th,this.matJoint); }
  mark(key,parent,pos){ const o=new THREE.Object3D(); o.position.set(...pos); parent.add(o); this.marks[key]=o; return o; }
  build(){
    this.joint('hips',null,[0,0.97,0],null);
    this.joint('spine','hips',[0,0.10,0],F.torsoY);
    this.joint('chest','spine',[0,0.18,0],F.torsoY);
    this.joint('neck','chest',[0,0.22,0],F.torsoY);
    this.joint('head','neck',[0,0.085,0],F.torsoY);
    this.headGroup=new THREE.Group(); this.J.head.add(this.headGroup);
    this.ell('hips','hips',[0,-0.01,0],[0.155,0.10,0.105],F.one,F.pelvis);
    this.ell('spine','spine',[0,0.08,0],[0.12,0.10,0.085],F.torsoY,F.belly);
    this.ell('chest','chest',[0,0.11,0.005],[0.165,0.15,0.105],F.torsoY,F.chest);
    this.cap('neck','neck',0.042,0.07,[0,0.045,0],F.torsoY,F.neck);
    this.ell('head',this.headGroup,[0,0.11,0.005],[0.088,0.112,0.098]);
    this.ell('head',this.headGroup,[0,0.085,0.097],[0.016,0.022,0.016]);
    const hg=this.headGroup;
    this.mark('nose',hg,[0,0.085,0.11]); this.mark('eyeL',hg,[0.034,0.125,0.083]); this.mark('eyeR',hg,[-0.034,0.125,0.083]);
    this.mark('earL',hg,[0.088,0.105,0]); this.mark('earR',hg,[-0.088,0.105,0]);
    for(const s of ['L','R']){
      const sx=s==='L'?1:-1;              // person's left = +X (the doll faces +Z)
      this.joint('shoulder'+s,'chest',[0.165*sx,0.17,0],F.shJ);
      this.joint('elbow'+s,'shoulder'+s,[0,-0.28,0],F.armY);
      this.joint('wrist'+s,'elbow'+s,[0,-0.25,0],F.armY);
      this.joint('hip'+s,'hips',[0.095*sx,-0.06,0],F.hipJ);
      this.joint('knee'+s,'hip'+s,[0,-0.42,0],F.legY);
      this.joint('ankle'+s,'knee'+s,[0,-0.42,0],F.legY);
      this.ball('shoulder'+s,0.05); this.cap('shoulder'+s,'shoulder'+s,0.043,0.19,[0,-0.14,0],F.armY,F.armSeg);
      this.ball('elbow'+s,0.038);   this.cap('elbow'+s,'elbow'+s,0.036,0.17,[0,-0.125,0],F.armY,F.armSeg);
      this.ball('hip'+s,0.065);     this.cap('hip'+s,'hip'+s,0.068,0.28,[0,-0.21,0],F.legY,F.legSeg);
      this.ball('knee'+s,0.05);     this.cap('knee'+s,'knee'+s,0.05,0.32,[0,-0.21,0],F.legY,F.legSeg);
      this.ball('ankle'+s,0.04);    this.ell('ankle'+s,'ankle'+s,[0,-0.035,0.055],[0.048,0.032,0.115],F.one,F.foot);
      this.buildHand(s,sx);
    }
  }
  buildHand(s,sx){
    const W='wrist'+s;
    this.ell(W,W,[0,-0.048,0.002],[0.02,0.05,0.042]);
    const defs=[['index',0.027,-0.095,[0.042,0.026,0.022],0.0085],['middle',0.009,-0.098,[0.046,0.029,0.023],0.0088],
                ['ring',-0.009,-0.095,[0.043,0.027,0.022],0.0083],['pinky',-0.025,-0.088,[0.033,0.021,0.019],0.0074]];
    for(const [f,z,y,L,r] of defs){
      this.joint(fj(s,f,1),W,[0,y,z],null);
      this.joint(fj(s,f,2),fj(s,f,1),[0,-L[0],0],null);
      this.joint(fj(s,f,3),fj(s,f,2),[0,-L[1],0],null);
      for(let k=1;k<=3;k++) this.cap(fj(s,f,k),fj(s,f,k),r,Math.max(0.002,L[k-1]-r),[0,-L[k-1]/2,0]);
      this.fdef[s+f]={L,r};
      this.mark(`${s}_${f}_tip`,this.J[fj(s,f,3)],[0,-L[2],0]);
    }
    const tb=new THREE.Object3D(); tb.rotation.order='XZY';
    tb.position.set(-sx*0.008,-0.022,0.026); tb.rotation.set(-40*D2R,0,-sx*28*D2R); this.J[W].add(tb);
    const TL=[0.040,0.032,0.026]; this.fdef[s+'thumb']={L:TL,r:0.0122};
    this.joint(fj(s,'thumb',1),tb,[0,0,0],null);
    this.joint(fj(s,'thumb',2),fj(s,'thumb',1),[0,-TL[0],0],null);
    this.joint(fj(s,'thumb',3),fj(s,'thumb',2),[0,-TL[1],0],null);
    for(let k=1;k<=3;k++) this.cap(fj(s,'thumb',k),fj(s,'thumb',k),0.0105,Math.max(0.002,TL[k-1]-0.0105),[0,-TL[k-1]/2,0]);
    this.mark(`${s}_thumb_tip`,this.J[fj(s,'thumb',3)],[0,-TL[2],0]);
  }
  applyBody(){
    const B=this.body;
    for(const n in this.jf){ const d=this.jf[n]; if(!d.f) continue; const f=d.f(B); this.J[n].position.set(d.base.x*f[0],d.base.y*f[1],d.base.z*f[2]); }
    for(const p of this.parts){ const a=p.fp(B), b=p.fs(B); p.m.position.set(p.p.x*a[0],p.p.y*a[1],p.p.z*a[2]); p.m.scale.set(p.s.x*b[0],p.s.y*b[1],p.s.z*b[2]); }
    this.headGroup.scale.setScalar(B.head);
    this.group.scale.setScalar(B.height);
    dirty=true;
  }
  minY(){ this.group.updateMatrixWorld(true); const box=new THREE.Box3(); this.meshes.forEach(m=>box.expandByObject(m)); return box.min.y; }
  ground(){ const m=this.minY(); this.J.hips.position.y-=m/this.body.height; dirty=true; }
  setBody(b){ bodyEditAt=performance.now(); const grounded=Math.abs(this.minY())<0.03; this.body={...BODY_DEF,...b}; this.applyBody(); if(grounded) this.ground(); }
  getPose(){
    const rot={};
    for(const n of ALL_JOINTS){ const r=this.J[n].rotation; const v=[r.x,r.y,r.z].map(a=>Math.round(a*R2D*10)/10||0); if(v[0]||v[1]||v[2]) rot[n]=v; }
    const p=this.J.hips.position; return {rot,root:[p.x,p.y,p.z].map(v=>Math.round(v*1000)/1000)};
  }
  setPose(p){
    for(const n of ALL_JOINTS){ const v=(p.rot&&p.rot[n])||[0,0,0]; this.J[n].rotation.set(v[0]*D2R,v[1]*D2R,v[2]*D2R); }
    if(p.root) this.J.hips.position.set(...p.root); dirty=true;
  }
  getState(){ return {name:this.name,pos:this.group.position.toArray().map(v=>Math.round(v*1000)/1000),body:{...this.body},pose:this.getPose()}; }
  setState(s){ if(s.name) this.name=s.name; if(s.pos) this.group.position.fromArray(s.pos); this.body={...BODY_DEF,...(s.body||{})}; this.applyBody(); this.setPose(s.pose||{}); }
  dispose(){ figRoot.remove(this.group); if(this.handles) Object.values(this.handles).forEach(h=>ikGroup.remove(h)); this.matWood.dispose(); this.matJoint.dispose(); this.dropSkin(); this.matSkin.dispose(); }
  // human look: one seamless skin made in a bind pose (arms and legs a little apart, fingers spread) and skinned to the joints.
  // The doll parts stay as invisible proxies for clicking, grounding and framing.
  skinRig(){
    if(this.rig) return this.rig;
    const names=[...BODY_JOINTS,...FINGER_JOINTS('L'),...FINGER_JOINTS('R')], bones=names.map(n=>n==='head'?this.headGroup:this.J[n]);
    const parent=bones.map(o=>{ for(let p=o.parent;p;p=p.parent){ const i=bones.indexOf(p); if(i>=0) return i; } return -1; });
    return this.rig={bones,parent,idx:Object.fromEntries(names.map((n,i)=>[n,i]))};
  }
  skinPrims(){
    const B=this.body, {idx}=this.skinRig(), Gi=this.group.matrixWorld.clone().invert(), frames={};
    const frame=n=>frames[n]||(frames[n]=(()=>{
      const m=new THREE.Matrix4().multiplyMatrices(Gi,(n==='head'?this.headGroup:this.J[n]).matrixWorld), q=new THREE.Quaternion(), sc=V3(); m.decompose(V3(),q,sc);
      const e=new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).elements;
      return {m,sc:sc.x,R:[e[0],e[3],e[6],e[1],e[4],e[7],e[2],e[5],e[8]]};
    })());
    const mk=(owner,at,d,sx)=>{
      const f=frame(at), [fp,fr]=SK_F[d.g](B), lp=v=>new THREE.Vector3(v[0]*sx*fp[0],v[1]*fp[1],v[2]*fp[2]).applyMatrix4(f.m).toArray();
      const q={t:{c:'cone',e:'ell',b:'box'}[d.t],k:d.k,bone:idx[owner],sel:ALL_JOINTS.indexOf(owner),ghost:!!d.ghost};
      if(d.t==='c'){ q.a=lp(d.a); q.b=lp(d.b); q.ra=d.ra*fr[0]*f.sc; q.rb=d.rb*fr[0]*f.sc; }
      else { q.c=lp(d.c); q.R=f.R; if(d.t==='e') q.r=d.r.map((v,i)=>v*fr[i]*f.sc); else { q.he=d.he.map((v,i)=>v*fr[i]*f.sc); q.rr=d.rr*f.sc; } }
      return q;
    };
    const SIDED=/^(shoulder|elbow|wrist|hip|knee|ankle)$/, body=[], hands={L:[],R:[]};
    for(const d of ANAT){ if(!SIDED.test(d.j)){ body.push(mk(d.j,d.j,d,1)); continue; } for(const s of ['L','R']) body.push(mk(d.j+s,(d.at||d.j)+s,d,s==='L'?1:-1)); }
    for(const s of ['L','R']){
      const sx=s==='L'?1:-1, H=hands[s];
      for(const d of ANAT_HAND) H.push(mk(d.j+s,(d.at||d.j)+s,d,sx));
      for(const f of FINGERS){ const {L,r}=this.fdef[s+f];
        for(let k=1;k<=3;k++) H.push(mk(fj(s,f,k),fj(s,f,k),{t:'c',a:[0,0,0],b:[0,-L[k-1],0],ra:r*(1.06-0.06*(k-1)),rb:r*(1.06-0.06*k),g:'hnd',k:.0015},1)); }
      H.push(mk(fj(s,'thumb',1),fj(s,'thumb',1),{t:'e',c:[0,-0.014,0.006],r:[0.017,0.032,0.02],g:'hnd',k:.02},sx));   // thenar
    }
    return {body,hands};
  }
  updateSkin(coarse){
    const rig=this.skinRig(), J=this.J, saved=ALL_JOINTS.map(n=>J[n].rotation.clone());
    for(const n of ALL_JOINTS) J[n].rotation.set(0,0,0);
    J.shoulderL.rotation.z=45*D2R; J.shoulderR.rotation.z=-45*D2R; J.hipL.rotation.z=8*D2R; J.hipR.rotation.z=-8*D2R;
    for(const s of ['L','R']) setSpread(this,s,12);
    this.group.updateMatrixWorld(true);
    const {body,hands}=this.skinPrims(), c=coarse?1.8:1, [hb,sb]=SKIN_Q.body, [hh,sh]=SKIN_Q.hand;
    const res=buildSkin([{prims:body,h:hb*c,sigma:sb},{prims:hands.L,h:hh*c,sigma:sh},{prims:hands.R,h:hh*c,sigma:sh}],rig.parent);
    this.dropSkin();
    const skel=new THREE.Skeleton(rig.bones);   // bone inverses from the bind pose
    const meshes=res.map(r=>{
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.BufferAttribute(r.pos,3)); g.setAttribute('normal',new THREE.BufferAttribute(r.nor,3));
      g.setAttribute('skinIndex',new THREE.BufferAttribute(r.si,4)); g.setAttribute('skinWeight',new THREE.BufferAttribute(r.sw,4));
      g.setAttribute('aSel',new THREE.BufferAttribute(r.sel,1)); g.setIndex(new THREE.BufferAttribute(r.idx,1));
      const m=new THREE.SkinnedMesh(g,this.matSkin); m.frustumCulled=false; m.userData={fig:this,skin:true};
      this.group.add(m); m.updateMatrixWorld(true); m.bind(skel,m.matrixWorld); return m;
    });
    saved.forEach((r,i)=>J[ALL_JOINTS[i]].rotation.copy(r));
    this.group.updateMatrixWorld(true);
    this.skin={meshes,skel,key:JSON.stringify(this.body),coarse}; this.showLook(); dirty=true;
  }
  dropSkin(){ if(!this.skin) return; for(const m of this.skin.meshes){ this.group.remove(m); m.geometry.dispose(); } this.skin.skel.dispose(); this.skin=null; }
  syncSkin(fine){   // rebuild when the body changed (coarse while a slider is moving, then fine)
    if(look!=='human') return;
    const s=this.skin; if(s&&s.key===JSON.stringify(this.body)&&(!s.coarse||!fine)) return;
    this.updateSkin(!fine);
  }
  showLook(){ const h=look==='human'; this.meshes.forEach(m=>m.visible=!h); if(this.skin) this.skin.meshes.forEach(m=>m.visible=h); }
  // OpenPose keypoints (COCO-18)
  kpBody(cam){
    this.group.updateMatrixWorld(true);
    const w=n=>wpos(this.J[n]), mk=k=>wpos(this.marks[k]);
    const neck=w('shoulderL').add(w('shoulderR')).multiplyScalar(.5);
    const pts=[mk('nose'),neck,w('shoulderR'),w('elbowR'),w('wristR'),w('shoulderL'),w('elbowL'),w('wristL'),
      w('hipR'),w('kneeR'),w('ankleR'),w('hipL'),w('kneeL'),w('ankleL'),mk('eyeR'),mk('eyeL'),mk('earR'),mk('earL')];
    const q=wquat(this.headGroup);
    const fwd=new THREE.Vector3(0,0,1).applyQuaternion(q), out=new THREE.Vector3(1,0,0).applyQuaternion(q);
    const cp=wpos(cam), toCam=p=>cp.clone().sub(p).normalize();
    const vis=new Array(18).fill(true);
    vis[0]=fwd.dot(toCam(pts[0]))>-0.2;
    vis[14]=fwd.clone().addScaledVector(out,-0.7).normalize().dot(toCam(pts[14]))>0.1;
    vis[15]=fwd.clone().addScaledVector(out,0.7).normalize().dot(toCam(pts[15]))>0.1;
    vis[16]=out.clone().negate().dot(toCam(pts[16]))>-0.25;
    vis[17]=out.dot(toCam(pts[17]))>-0.25;
    return {pts,vis};
  }
  kpHand(s){
    const pts=[wpos(this.J['wrist'+s])];
    for(const f of FINGERS){ for(let k=1;k<=3;k++) pts.push(wpos(this.J[fj(s,f,k)])); pts.push(wpos(this.marks[`${s}_${f}_tip`])); }
    return pts;
  }
}

// hands
const HAND_PRESETS={'開く':[0,0,0,0,0,15],'リラックス':[.25,.2,.28,.35,.42,6],'グー':[.9,1,1,1,1,0],'ピース':[.75,0,0,1,1,16],
  '指さし':[.7,0,1,1,1,2],'OK':[.55,.72,.08,.15,.22,8],'そろえる':[0,0,0,0,0,0],'つかむ':[.45,.5,.55,.6,.65,4]};
const SPREAD_W={index:-1,middle:0,ring:.5,pinky:1};
function setFinger(fig,s,f,c){
  const sx=s==='L'?1:-1, J=fig.J;
  if(f==='thumb'){ const r1=J[fj(s,f,1)].rotation; r1.set(r1.x,r1.y,-sx*c*35*D2R); J[fj(s,f,2)].rotation.set(0,0,-sx*c*40*D2R); J[fj(s,f,3)].rotation.set(0,0,-sx*c*60*D2R); }
  else { const r1=J[fj(s,f,1)].rotation; r1.set(r1.x,0,-sx*c*85*D2R); J[fj(s,f,2)].rotation.set(0,0,-sx*c*100*D2R); J[fj(s,f,3)].rotation.set(0,0,-sx*c*70*D2R); }
}
function setSpread(fig,s,sp){ for(const f of ['index','middle','ring','pinky']){ const r=fig.J[fj(s,f,1)].rotation; r.set(SPREAD_W[f]*sp*D2R,r.y,r.z); } }
function getCurl(fig,s,f){ const sx=s==='L'?1:-1; const z=fig.J[fj(s,f,f==='thumb'?3:2)].rotation.z*R2D; return clamp(-sx*z/(f==='thumb'?60:100),0,1); }
const getSpread=(fig,s)=>fig.J[fj(s,'pinky',1)].rotation.x*R2D;
const handSides=()=>handSide==='B'?['L','R']:[handSide];

// pose presets (degrees; limbs: -X forward, +Z outward on the left)
const P=(rot,root=0.97,ground=true)=>({rot,root,ground});
const PRESETS={
  '直立':P({shoulderL:[0,0,8],shoulderR:[0,0,-8],elbowL:[-8,0,0],elbowR:[-8,0,0]}),
  'Tポーズ':P({shoulderL:[0,0,90],shoulderR:[0,0,-90]}),
  'Aポーズ':P({shoulderL:[0,0,45],shoulderR:[0,0,-45]}),
  '歩く':P({hipL:[-25,0,0],kneeL:[10,0,0],hipR:[18,0,0],kneeR:[28,0,0],ankleR:[15,0,0],
          shoulderL:[18,0,6],shoulderR:[-22,0,-6],elbowL:[-10,0,0],elbowR:[-30,0,0],spine:[0,6,0],chest:[0,-8,0]}),
  '走る':P({hipL:[-65,0,0],kneeL:[75,0,0],ankleL:[10,0,0],hipR:[25,0,0],kneeR:[55,0,0],ankleR:[25,0,0],
          shoulderL:[40,0,10],elbowL:[-85,0,0],shoulderR:[-50,0,-10],elbowR:[-95,0,0],spine:[12,0,0],chest:[5,0,0],neck:[-12,0,0]}),
  '座る':P({hipL:[-90,0,4],hipR:[-90,0,-4],kneeL:[90,0,0],kneeR:[90,0,0],
          shoulderL:[-25,0,6],shoulderR:[-25,0,-6],elbowL:[-45,0,0],elbowR:[-45,0,0]},0.56),
  'しゃがむ':P({hipL:[-110,0,10],hipR:[-110,0,-10],kneeL:[140,0,0],kneeR:[140,0,0],ankleL:[-30,0,0],ankleR:[-30,0,0],
          spine:[25,0,0],neck:[-15,0,0],shoulderL:[-50,0,10],shoulderR:[-50,0,-10],elbowL:[-30,0,0],elbowR:[-30,0,0]},0.36),
  '手を振る':P({shoulderL:[0,0,8],elbowL:[-8,0,0],shoulderR:[0,-90,-80],elbowR:[-110,0,0],head:[0,0,6],hipL:[0,0,3],hipR:[0,0,3]}),
  'ジャンプ':P({shoulderL:[0,0,150],shoulderR:[0,0,-150],elbowL:[-15,0,0],elbowR:[-15,0,0],hipL:[-40,0,5],kneeL:[80,0,0],
          hipR:[-10,0,-5],kneeR:[45,0,0],ankleL:[30,0,0],ankleR:[30,0,0],spine:[-8,0,0]},1.25,false),
};

// props
const PROP_LABEL={chair:'椅子',box:'箱',steps:'段差',table:'テーブル',wall:'壁',pillar:'柱'};
class Prop{
  constructor(type){
    this.type=type; this.obj=new THREE.Group(); propRoot.add(this.obj); this.meshes=[];
    const add=(geo,w,h,d,x,y,z)=>{ const m=new THREE.Mesh(geo,matProp); m.scale.set(w,h,d); m.position.set(x,y,z); m.userData={prop:this}; this.obj.add(m); this.meshes.push(m); };
    switch(type){
      case 'chair': add(BOX,.44,.05,.42,0,.445,0); for(const [x,z] of [[-.19,-.18],[.19,-.18],[-.19,.18],[.19,.18]]) add(BOX,.04,.42,.04,x,.21,z); add(BOX,.44,.42,.04,0,.68,-.19); break;
      case 'box': add(BOX,.5,.5,.5,0,.25,0); break;
      case 'steps': for(let i=0;i<3;i++) add(BOX,.9,(i+1)*.18,.28,0,(i+1)*.09,-i*.28); break;
      case 'table': add(BOX,1,.04,.6,0,.72,0); for(const [x,z] of [[-.46,-.26],[.46,-.26],[-.46,.26],[.46,.26]]) add(BOX,.04,.70,.04,x,.35,z); break;
      case 'wall': add(BOX,2.4,2.4,.1,0,1.2,0); break;
      case 'pillar': add(CYL,.15,2.4,.15,0,1.2,0); break;
    }
  }
  getState(){ const o=this.obj, r=v=>Math.round(v*1000)/1000; return {type:this.type,pos:o.position.toArray().map(r),rot:[o.rotation.x,o.rotation.y,o.rotation.z].map(a=>Math.round(a*R2D*10)/10),scl:o.scale.toArray().map(r)}; }
  setState(s){ const o=this.obj; if(s.pos) o.position.fromArray(s.pos); if(s.rot) o.rotation.set(s.rot[0]*D2R,s.rot[1]*D2R,s.rot[2]*D2R); if(s.scl) o.scale.fromArray(s.scl); }
  dispose(){ propRoot.remove(this.obj); }
}

// scene state / undo
function defaultFigureState(x){ const p=PRESETS['直立']; return {pos:[x,0,0],body:{...BODY_DEF},pose:{rot:p.rot,root:[0,p.root,0]}}; }
function createFigure(name){ const f=new Figure(name||`人物${++figNo}`); figures.push(f); syncHandles(); return f; }
function removeFigure(f){ f.dispose(); figures=figures.filter(x=>x!==f); if(sel&&sel.fig===f) select(null); if(active===f) active=figures[0]||null; }
function getScene(){ return {v:2,figures:figures.map(f=>f.getState()),props:props.map(p=>p.getState()),active:Math.max(0,figures.indexOf(active))}; }
function setScene(s){
  if(!s) return;
  if(!s.v) s={v:2,figures:[{body:{...BODY_DEF,head:s.head||1},pose:{rot:s.rot||{},root:s.root}}],props:[]}; // v1 file
  if(!Array.isArray(s.figures)||!s.figures.length) return;
  const keepSel=sel;
  while(figures.length>s.figures.length) removeFigure(figures[figures.length-1]);
  while(figures.length<s.figures.length) createFigure();
  s.figures.forEach((fs,i)=>figures[i].setState(fs));
  props.forEach(p=>p.dispose()); props=[];
  (s.props||[]).forEach(ps=>{ if(!PROP_LABEL[ps.type]) return; const p=new Prop(ps.type); p.setState(ps); props.push(p); });
  active=figures[clamp(s.active||0,0,figures.length-1)];
  if(keepSel && keepSel.kind!=='prop' && figures.includes(keepSel.fig)) select(keepSel); else select(null);
  syncHandles(); refreshFigUI(); dirty=true;
}
function commit(){
  const s=JSON.stringify(getScene());
  if(undoStack[undoStack.length-1]!==s){ undoStack.push(s); if(undoStack.length>150) undoStack.shift(); redoStack=[]; }
  lsSet('posedoll:v2',s); updUndo(); refreshHandUI(); dirty=true;
}
function undo(){ if(undoStack.length<2) return; redoStack.push(undoStack.pop()); setScene(JSON.parse(undoStack[undoStack.length-1])); lsSet('posedoll:v2',undoStack[undoStack.length-1]); updUndo(); }
function redo(){ if(!redoStack.length) return; const s=redoStack.pop(); undoStack.push(s); setScene(JSON.parse(s)); lsSet('posedoll:v2',s); updUndo(); }
function updUndo(){ $('undo').disabled=undoStack.length<2; $('redo').disabled=!redoStack.length; }

// selection & gizmo
const gizmo=new TransformControls(camera,renderer.domElement);
gizmo.setSpace('local'); gizmo.setMode('rotate'); gizmo.size=0.75; scene.add(gizmo);

function applyHighlight(){
  for(const f of figures){ for(const m of f.meshes) m.material=m.userData.base; f.matSkin.userData.uSel.value=(sel?.kind==='joint'&&sel.fig===f)?ALL_JOINTS.indexOf(sel.name):-1; }
  for(const p of props) for(const m of p.meshes) m.material=matProp;
  if(!sel) return;
  if(sel.kind==='joint') for(const m of sel.fig.meshes) if(m.userData.joint===sel.name) m.material=matSel;
  if(sel.kind==='prop') for(const m of sel.prop.meshes) m.material=matPropSel;
}
function select(s){
  sel=s||null;
  if(sel&&sel.fig&&sel.fig!==active){ active=sel.fig; refreshFigUI(); }
  applyHighlight();
  if(!sel) gizmo.detach();
  else if(sel.kind==='joint'){ gizmo.attach(sel.fig.J[sel.name]); const mv=sel.name==='hips'&&moveMode; gizmo.setMode(mv?'translate':'rotate'); gizmo.setSpace(mv?'world':'local'); }
  else if(sel.kind==='ik'){ gizmo.attach(sel.handle); gizmo.setMode('translate'); gizmo.setSpace('world'); }
  else if(sel.kind==='prop'){ gizmo.attach(sel.prop.obj); gizmo.setMode(propMode); gizmo.setSpace(propMode==='translate'?'world':'local'); }
  gizmo.size=(sel&&sel.kind==='joint'&&sel.name.startsWith('f'))?0.4:(sel&&sel.kind==='ik'?0.6:0.75);
  updateSelUI();
}
function updateSelUI(){
  const chip=$('selChip');
  let txt='';
  if(sel?.kind==='joint') txt=`${sel.fig.name}・${jointLabel(sel.name)}`;
  else if(sel?.kind==='ik') txt=`${sel.fig.name}・${jointLabel(sel.end)}（IK）`;
  else if(sel?.kind==='prop') txt=PROP_LABEL[sel.prop.type];
  chip.hidden=!txt; chip.textContent=txt;
  const isJ=sel?.kind==='joint';
  $('jointSel').value=isJ?sel.name:'';
  ['rx','ry','rz','resetJoint','modeRot'].forEach(id=>$(id).disabled=!isJ);
  $('modeMove').disabled=!(isJ&&sel.name==='hips');
  $('modeRot').classList.toggle('on',!(isJ&&sel.name==='hips'&&moveMode));
  $('modeMove').classList.toggle('on',isJ&&sel.name==='hips'&&moveMode);
  const isP=sel?.kind==='prop';
  $('propCtl').hidden=!isP; $('propHint').hidden=isP;
  if(isP){ $('propName').textContent=`選択中：${PROP_LABEL[sel.prop.type]}`; document.querySelectorAll('[data-pmode]').forEach(b=>b.classList.toggle('on',b.dataset.pmode===propMode)); }
  syncSliders();
}
function syncSliders(){
  const isJ=sel?.kind==='joint'; const L=isJ&&limitsOn?limitsFor(sel.name):null;
  ['x','y','z'].forEach((a,i)=>{
    const el=$('r'+a); el.min=L?L[i][0]:-180; el.max=L?L[i][1]:180;
    const v=isJ?Math.round(sel.fig.J[sel.name].rotation[a]*R2D):0; el.value=v; $('o'+a).textContent=v+'°';
  });
}

// IK
const IK_ENDS=['wristL','wristR','ankleL','ankleR'];
const IK_MIDS=['elbowL','elbowR','kneeL','kneeR'];   // elbow / knee handles: swing the limb around the root→end line, the end stays put
const IK_ALL=[...IK_ENDS,...IK_MIDS];
// rotation about a given axis that turns u toward v (both taken perpendicular to the axis); setFromUnitVectors picks a random axis near 180°
const rollAbout=(axis,u,v)=>new THREE.Quaternion().setFromAxisAngle(axis,Math.atan2(u.clone().cross(v).dot(axis),u.dot(v)));
const limbOf=n=>{ const s=n.slice(-1), arm=/^(wrist|elbow)/.test(n); return {root:(arm?'shoulder':'hip')+s,mid:(arm?'elbow':'knee')+s,end:(arm?'wrist':'ankle')+s}; };
function syncHandles(){
  ikGroup.visible=ikOn;
  for(const f of figures){
    if(f.handles) continue; f.handles={};
    for(const e of IK_ALL){ const h=new THREE.Mesh(HANDLE_GEO,matHandle); h.renderOrder=999; h.userData={ik:true,fig:f,end:e}; ikGroup.add(h); f.handles[e]=h; }
  }
}
function updateHandles(){
  if(!ikOn) return;
  for(const f of figures) for(const e of IK_ALL){ const h=f.handles[e]; if(gizmo.dragging&&sel?.handle===h) continue; f.J[e].getWorldPosition(h.position); h.scale.setScalar(f.body.height*(IK_MIDS.includes(e)?0.8:1)); }
}
const wrapA=a=>Math.atan2(Math.sin(a),Math.cos(a));
// the same XZY rotation can also be written (x+180, 180-z, y+180); keep the one with smaller bend/twist so the joint limits clamp sensibly
function tidyEuler(o){ const r=o.rotation, x2=wrapA(r.x+Math.PI), y2=wrapA(r.y+Math.PI), z2=wrapA(Math.PI-r.z);
  if(Math.abs(x2)+Math.abs(y2)<Math.abs(r.x)+Math.abs(r.y)-1e-6) r.set(x2,y2,z2); }
function setWorldQuat(o,q){ const pq=wquat(o.parent).invert(); o.quaternion.copy(pq.multiply(q)); tidyEuler(o); }
function solveLimb(fig,end,target,keepQ){
  const s=end.slice(-1), arm=end.startsWith('wrist');
  const a=fig.J[(arm?'shoulder':'hip')+s], b=fig.J[(arm?'elbow':'knee')+s], c=fig.J[end];
  fig.group.updateMatrixWorld(true);
  const pa=wpos(a), pb=wpos(b), pc=wpos(c);
  const lab=pa.distanceTo(pb), lbc=pb.distanceTo(pc);
  const d=clamp(pa.distanceTo(target),Math.abs(lab-lbc)+1e-4,lab+lbc-1e-4);
  const interior=Math.acos(clamp((lab*lab+lbc*lbc-d*d)/(2*lab*lbc),-1,1));
  b.rotation.set((arm?-1:1)*(Math.PI-interior),b.rotation.y,0);
  fig.group.updateMatrixWorld(true);
  const v1=wpos(c).sub(pa), v2=target.clone().sub(pa);
  if(v1.lengthSq()>1e-10&&v2.lengthSq()>1e-10){ const q=new THREE.Quaternion().setFromUnitVectors(v1.normalize(),v2.normalize()); setWorldQuat(a,q.multiply(wquat(a))); }
  if(keepQ){ fig.group.updateMatrixWorld(true); setWorldQuat(c,keepQ); }
  [a,b,c].forEach(j=>clampJoint(fig,j.name));
  dirty=true;
}
// elbow / knee: rotate the root about the root→end axis so the mid joint turns toward the target; the end keeps its place and angle.
// When the limb is straight there is no swing circle, so the whole limb is aimed at the target instead.
function solvePole(fig,mid,target,keepQ){
  const L=limbOf(mid), a=fig.J[L.root], b=fig.J[L.mid], c=fig.J[L.end];
  fig.group.updateMatrixWorld(true);
  const pa=wpos(a), pb=wpos(b), pc=wpos(c), ax=pc.clone().sub(pa).normalize();
  const perp=v=>{ const w=v.clone().sub(pa); return w.addScaledVector(ax,-w.dot(ax)); };
  const u=perp(pb), v=perp(target);
  let q=null;
  if(u.length()>0.01*fig.body.height&&v.lengthSq()>1e-10) q=rollAbout(ax,u,v);
  else { const v1=pb.clone().sub(pa), v2=target.clone().sub(pa); if(v1.lengthSq()>1e-10&&v2.lengthSq()>1e-10) q=new THREE.Quaternion().setFromUnitVectors(v1.normalize(),v2.normalize()); }
  if(q) setWorldQuat(a,q.multiply(wquat(a)));
  if(keepQ){ fig.group.updateMatrixWorld(true); setWorldQuat(c,keepQ); }
  [a,b,c].forEach(j=>clampJoint(fig,j.name));
  dirty=true;
}
// elbow: the elbow goes where it is dragged (kept at upper-arm length from the shoulder; the upper arm turns the shortest way, no twist),
// then the elbow hinge bends so the hand gets as close as it can to where it was when the drag started (anchor).
// No roll about the arm: a hand that must stay put would often need an impossible twist and the limits would throw the arm around.
function solveElbow(fig,mid,target,anchor){
  const L=limbOf(mid), a=fig.J[L.root], b=fig.J[L.mid], c=fig.J[L.end];
  fig.group.updateMatrixWorld(true);
  const pa=wpos(a), pb=wpos(b), lab=pa.distanceTo(pb), dir=target.clone().sub(pa);
  if(dir.lengthSq()<1e-10) return;
  dir.normalize();
  setWorldQuat(a,new THREE.Quaternion().setFromUnitVectors(pb.clone().sub(pa).normalize(),dir).multiply(wquat(a)));
  clampJoint(fig,a.name);
  b.rotation.set(0,b.rotation.y,0); fig.group.updateMatrixWorld(true);
  const E=wpos(b), up=E.clone().sub(wpos(a)).normalize(), h=new THREE.Vector3(1,0,0).applyQuaternion(wquat(b));   // hinge axis
  const p=anchor.clone().sub(E); p.addScaledVector(h,-p.dot(h));
  if(p.lengthSq()>1e-10){
    const lim=limitsOn?limitsFor(b.name)[0]:[-180,180];
    b.rotation.x=clamp(Math.atan2(up.clone().cross(p).dot(h),up.dot(p)),lim[0]*D2R,lim[1]*D2R);
  }
  [b,c].forEach(j=>clampJoint(fig,j.name));
  dirty=true;
}

gizmo.addEventListener('dragging-changed',e=>{
  orbit.enabled=!e.value;
  if(e.value){
    dragCtx=null;
    if(sel?.kind==='ik'&&sel.end.startsWith('elbow')) dragCtx={anchor:wpos(sel.fig.J[limbOf(sel.end).end])};   // elbow: the hand tries to stay where it was
    else if(sel?.kind==='ik'&&IK_MIDS.includes(sel.end)) dragCtx={keepQ:wquat(sel.fig.J[limbOf(sel.end).end])};   // knee: the foot keeps its place and angle
    else if(sel?.kind==='ik') dragCtx={keepQ:sel.end.startsWith('ankle')?wquat(sel.fig.J[sel.end]):null};   // feet keep their angle; hands follow the forearm
    else if(sel?.kind==='joint'&&sel.name==='hips'&&$('pinFeet').checked){ const f=sel.fig; dragCtx={pins:['L','R'].map(s=>({s,pos:wpos(f.J['ankle'+s]),q:wquat(f.J['ankle'+s])}))}; }
  } else { dragCtx=null; commit(); }
});
gizmo.addEventListener('objectChange',()=>{
  if(!sel) return;
  if(sel.kind==='ik'&&sel.end.startsWith('elbow')) solveElbow(sel.fig,sel.end,sel.handle.position,dragCtx.anchor);
  else if(sel.kind==='ik') (IK_MIDS.includes(sel.end)?solvePole:solveLimb)(sel.fig,sel.end,sel.handle.position,dragCtx&&dragCtx.keepQ);
  else if(sel.kind==='joint'){
    clampJoint(sel.fig,sel.name);
    if(sel.name==='hips'&&dragCtx?.pins) for(const p of dragCtx.pins) solveLimb(sel.fig,'ankle'+p.s,p.pos,p.q);
  }
  syncSliders(); dirty=true;
});

// picking
const ray=new THREE.Raycaster(), ndc=new THREE.Vector2(); let downPos=null;
renderer.domElement.addEventListener('pointerdown',e=>{ downPos=gizmo.axis?null:[e.clientX,e.clientY]; const a=document.activeElement; if(a&&a!==document.body&&a.blur) a.blur(); });   // so Tab / arrows go to the viewport
renderer.domElement.addEventListener('pointerup',e=>{
  if(!downPos) return; const dx=e.clientX-downPos[0], dy=e.clientY-downPos[1]; downPos=null;
  if(dx*dx+dy*dy>25) return;
  const r=renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1);
  ray.setFromCamera(ndc,camera);
  if(ikOn){ const hs=figures.flatMap(f=>Object.values(f.handles)); const h=ray.intersectObjects(hs,false)[0];
    if(h){ const u=h.object.userData; select({kind:'ik',fig:u.fig,end:u.end,handle:h.object}); return; } }
  const targets=[...figures.flatMap(f=>f.meshes),...props.flatMap(p=>p.meshes)];
  const hit=ray.intersectObjects(targets,false)[0];
  if(!hit) return select(null);
  const u=hit.object.userData;
  if(u.prop) select({kind:'prop',prop:u.prop}); else select({kind:'joint',fig:u.fig,name:u.joint});
});

// UI: figures & tabs
function refreshFigUI(){
  const fs=$('figSel'); fs.innerHTML='';
  figures.forEach((f,i)=>fs.append(new Option(f.name,String(i))));
  fs.value=String(Math.max(0,figures.indexOf(active)));
  $('figDel').disabled=figures.length<2;
  refreshBodyUI(); refreshHandUI(); dirty=true;
}
$('figSel').addEventListener('change',()=>{ active=figures[+$('figSel').value]; if(sel&&sel.fig&&sel.fig!==active) select(null); refreshFigUI(); });
function nextX(){ let m=-Infinity; for(const f of figures){ const x=wpos(f.J.hips).x; if(x>m) m=x; } return isFinite(m)?m+0.75:0; }
$('figAdd').onclick=()=>{ const s=defaultFigureState(nextX()); const f=createFigure(); f.setState(s); f.ground(); active=f; refreshFigUI(); select(null); commit(); };
$('figDup').onclick=()=>{ const s=active.getState(); delete s.name; s.pos=[s.pos[0]+0.75,s.pos[1],s.pos[2]]; const f=createFigure(); f.setState(s); active=f; refreshFigUI(); select(null); commit(); };
$('figDel').onclick=()=>{ if(figures.length<2) return; removeFigure(active); active=figures[0]; select(null); refreshFigUI(); commit(); };

document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
function showTab(t){
  document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===t)));
  document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==t);
  lsSet('posedoll:tab',t); if(t==='out') dirty=true;
}

// joint panel
(function buildJointSel(){
  const js=$('jointSel'); js.append(new Option('— 関節を選ぶ —',''));
  const groups=[['体',BODY_JOINTS],['左手の指',FINGER_JOINTS('L')],['右手の指',FINGER_JOINTS('R')]];
  for(const [g,list] of groups){ const og=document.createElement('optgroup'); og.label=g; list.forEach(n=>og.append(new Option(jointLabel(n),n))); js.append(og); }
  js.addEventListener('change',()=>select(js.value?{kind:'joint',fig:active,name:js.value}:null));
})();
['x','y','z'].forEach(a=>{
  const el=$('r'+a);
  el.addEventListener('input',()=>{ if(sel?.kind!=='joint') return; sel.fig.J[sel.name].rotation[a]=el.value*D2R; $('o'+a).textContent=el.value+'°'; dirty=true; });
  el.addEventListener('change',commit);
});
$('resetJoint').onclick=()=>{ if(sel?.kind!=='joint') return; sel.fig.J[sel.name].rotation.set(0,0,0); syncSliders(); commit(); };
$('modeRot').onclick=()=>{ moveMode=false; select(sel); };
$('modeMove').onclick=()=>{ moveMode=true; select(sel); };

// pose presets & tools
Object.keys(PRESETS).forEach(n=>{ const b=document.createElement('button'); b.textContent=n; b.onclick=()=>applyPreset(n); $('presets').append(b); });
function applyPreset(name){
  const p=PRESETS[name], f=active, cur=f.J.hips.position.clone(), yaw=f.J.hips.rotation.y;
  const keep={}; for(const n of ALL_JOINTS) if(n.startsWith('f')){ const r=f.J[n].rotation; keep[n]=[r.x*R2D,r.y*R2D,r.z*R2D]; }
  f.setPose({rot:{...keep,...p.rot},root:[cur.x,p.root,cur.z]});
  if(!p.rot.hips) f.J.hips.rotation.y=yaw;
  for(const n of ALL_JOINTS) clampJoint(f,n);
  if(p.ground) f.ground();
  syncSliders(); commit();
}
// natural-language poses (v1.5): the user pastes an LLM's JSON written with the instruction sheet (llm_prompt.md)
function llmPrompt(){ const req=$('llmReq').value.trim(); return LLM_PROMPT+'\n\n## 今回のポーズ\n'+(req||'（ここに作りたいポーズを書く）')+'\n'; }
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }catch(e){}
  const ta=document.createElement('textarea'); ta.value=t; document.body.append(ta); ta.select(); let ok=false; try{ ok=document.execCommand('copy'); }catch(e){} ta.remove(); return ok;
}
function applyLLM(text){
  let o; try{ o=parseLoose(text); }catch(e){ return {ok:false,msg:'JSON として読めませんでした。LLM の返事をそのまま貼ってください。'}; }
  if(o.figures&&!o.pose){ setScene(o); commit(); return {ok:true,msg:'シーンを読み込みました。'}; }
  if(o.posedollPose&&o.pose&&o.pose.rot){ loadLibItem(o); return {ok:true,msg:'保存庫のポーズを反映しました。'}; }
  const p=llmToPose(o); if(!Object.keys(p.rot).length&&!Object.keys(p.hands).length) return {ok:false,msg:'関節が1つも見つかりませんでした。'};
  const f=active, cur=f.J.hips.position.clone(), yaw=f.J.hips.rotation.y;
  const keep={}; for(const n of ALL_JOINTS) if(n.startsWith('f')){ const r=f.J[n].rotation; keep[n]=[r.x*R2D,r.y*R2D,r.z*R2D]; }
  f.setPose({rot:{...keep,...p.rot},root:[cur.x,cur.y,cur.z]});
  if(!p.rot.hips) f.J.hips.rotation.y=yaw;
  for(const s in p.hands){ const v=HAND_PRESETS[p.hands[s]]; if(!v){ p.warn.push('hands.'+s); continue; } FINGERS.forEach((fi,i)=>setFinger(f,s,fi,v[i])); setSpread(f,s,v[5]); }
  let clamped=0; if(limitsOn) for(const n of ALL_JOINTS){ const r=f.J[n].rotation, b=[r.x,r.y,r.z]; clampJoint(f,n); if(Math.abs(r.x-b[0])+Math.abs(r.y-b[1])+Math.abs(r.z-b[2])>0.02) clamped++; }
  f.ground(); if(p.lift) f.J.hips.position.y+=p.lift/f.body.height;
  if(p.name&&!$('libName').value) $('libName').value=p.name;
  syncSliders(); commit();
  return {ok:true,clamped,warn:p.warn,msg:`「${p.name||'ポーズ'}」を反映しました`+(clamped?`（可動域に合わせて ${clamped} か所を調整）`:'')+(p.warn.length?`。読めなかった項目: ${p.warn.join(', ')}`:'')+'。'};
}
function runLLM(){ const r=applyLLM($('llmIn').value); $('llmMsg').textContent=r.msg; toast(r.ok?'ポーズを反映しました':'反映できませんでした'); return r; }
$('llmCopy').onclick=async()=>toast(await copyText(llmPrompt())?'指示書をコピーしました。LLM に貼り付けてください':'コピーできませんでした。「指示書を保存」を使ってください');
$('llmSave').onclick=()=>saveFile('posedoll_LLM指示書.md',new Blob([llmPrompt()],{type:'text/markdown'}));
$('llmApply').onclick=runLLM;
$('llmIn').addEventListener('paste',()=>setTimeout(runLLM,0));
function mirrorPose(p){ const out={rot:{},root:p.root}; for(const n in p.rot){ const v=p.rot[n]; out.rot[otherSide(n)]=[v[0],-v[1],-v[2]]; } return out; }
$('mirror').onclick=()=>{ active.setPose(mirrorPose(active.getPose())); syncSliders(); commit(); };
function copySide(from){
  const p=active.getPose(), m=mirrorPose(p);
  for(const n of ALL_JOINTS){ const s=sideOf(n); if(s&&s!==from){ if(m.rot[n]) p.rot[n]=m.rot[n]; else delete p.rot[n]; } }
  active.setPose(p); syncSliders(); commit();
}
$('copyLR').onclick=()=>copySide('L');
$('copyRL').onclick=()=>copySide('R');
$('ground').onclick=()=>{ active.ground(); commit(); };
$('resetAll').onclick=()=>{ const r=active.J.hips.position; active.setPose({rot:{},root:[r.x,r.y,r.z]}); active.ground(); syncSliders(); commit(); };

// viewport toggles
$('tIK').onclick=()=>{ ikOn=!ikOn; $('tIK').classList.toggle('on',ikOn); syncHandles(); if(!ikOn&&sel?.kind==='ik') select(null); lsSet('posedoll:ik',ikOn?'1':'0'); };
$('tLim').onclick=()=>{ limitsOn=!limitsOn; $('tLim').classList.toggle('on',limitsOn); if(limitsOn){ for(const f of figures) for(const n of ALL_JOINTS) clampJoint(f,n); commit(); } syncSliders(); lsSet('posedoll:lim',limitsOn?'1':'0'); };

// hand panel
document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{ handSide=b.dataset.side; document.querySelectorAll('[data-side]').forEach(x=>x.classList.toggle('on',x===b)); refreshHandUI(); });
Object.keys(HAND_PRESETS).forEach(n=>{ const b=document.createElement('button'); b.textContent=n; b.onclick=()=>{
  const v=HAND_PRESETS[n]; for(const s of handSides()){ FINGERS.forEach((f,i)=>setFinger(active,s,f,v[i])); setSpread(active,s,v[5]); for(const j of FINGER_JOINTS(s)) clampJoint(active,j); }
  dirty=true; commit(); }; $('handPresets').append(b); });
(function buildFingerSliders(){
  const box=$('fingerSliders');
  const mk=(id,label,min,max,step)=>{ const d=document.createElement('div'); d.className='slider';
    d.innerHTML=`<label for="${id}">${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}"><output id="o_${id}"></output>`; box.append(d); return d.querySelector('input'); };
  FINGERS.forEach(f=>{ const el=mk('cu_'+f,FN_JA[f],0,100,1);
    el.addEventListener('input',()=>{ for(const s of handSides()){ setFinger(active,s,f,el.value/100); for(let k=1;k<=3;k++) clampJoint(active,fj(s,f,k)); } $('o_cu_'+f).textContent=el.value+'%'; dirty=true; });
    el.addEventListener('change',commit); });
  const sp=mk('spread','指の開き',-10,30,1);
  sp.addEventListener('input',()=>{ for(const s of handSides()) setSpread(active,s,+sp.value); $('o_spread').textContent=sp.value+'°'; dirty=true; });
  sp.addEventListener('change',commit);
})();
function refreshHandUI(){
  if(!active) return; const s=handSide==='R'?'R':'L';
  FINGERS.forEach(f=>{ const v=Math.round(getCurl(active,s,f)*100); $('cu_'+f).value=v; $('o_cu_'+f).textContent=v+'%'; });
  const sp=Math.round(getSpread(active,s)); $('spread').value=sp; $('o_spread').textContent=sp+'°';
}

// body panel
Object.keys(BODY_PRESETS).forEach(n=>{ const b=document.createElement('button'); b.textContent=n; b.onclick=()=>{ active.setBody(BODY_PRESETS[n]); refreshBodyUI(); commit(); }; $('bodyPresets').append(b); });
(function buildBodySliders(){
  const box=$('bodySliders');
  for(const k in BP_LABEL){ const [mn,mx]=BP_RANGE[k]; const d=document.createElement('div'); d.className='slider';
    d.innerHTML=`<label for="bp_${k}">${BP_LABEL[k]}</label><input type="range" id="bp_${k}" min="${mn}" max="${mx}" step="0.01"><output id="obp_${k}"></output>`; box.append(d);
    const el=d.querySelector('input');
    el.addEventListener('input',()=>{ active.setBody({...active.body,[k]:+el.value}); $('obp_'+k).textContent=(+el.value).toFixed(2); headsNote(); });
    el.addEventListener('change',commit); }
})();
function refreshBodyUI(){ if(!active) return; for(const k in BP_LABEL){ $('bp_'+k).value=active.body[k]; $('obp_'+k).textContent=(+active.body[k]).toFixed(2); } headsNote(); }
function headsNote(){
  const B=active.body;
  const above=0.585*B.torso+0.222*B.head, below=0.06+0.84*B.leg+0.067;   // rest pose, from hips up / down
  const total=(above+below)*B.height, headH=0.224*B.head*B.height;
  $('headsNote').textContent=`直立時の目安：身長 約${Math.round(total*100)}cm・約${(total/headH).toFixed(1)}頭身（標準の身長を178cmとした場合）`;
}

// scene panel
Object.keys(PROP_LABEL).forEach(t=>{ const b=document.createElement('button'); b.textContent=PROP_LABEL[t]; b.onclick=()=>addProp(t); $('propAdd').append(b); });
function addProp(t,state){
  const p=new Prop(t); props.push(p);
  if(state) p.setState(state);
  else { const h=wpos(active.J.hips); const off={chair:[0,-0.12],box:[0.7,0],steps:[0,-0.6],table:[0,0.55],wall:[0,-0.9],pillar:[0.8,-0.3]}[t]; p.obj.position.set(h.x+off[0],0,h.z+off[1]); }
  select({kind:'prop',prop:p}); commit(); return p;
}
document.querySelectorAll('[data-pmode]').forEach(b=>b.onclick=()=>{ propMode=b.dataset.pmode; if(sel?.kind==='prop') select(sel); });
$('propDup').onclick=()=>{ if(sel?.kind!=='prop') return; const s=sel.prop.getState(); s.pos[0]+=0.3; s.pos[2]+=0.3; addProp(s.type,s); };
function deleteProp(){ if(sel?.kind!=='prop') return; const p=sel.prop; p.dispose(); props=props.filter(x=>x!==p); select(null); commit(); }
$('propDel').onclick=deleteProp;
function setLook(v){
  look=v==='doll'?'doll':'human'; lsSet('posedoll:look',look);
  for(const f of figures){ f.syncSkin(true); f.showLook(); }
  document.querySelectorAll('[data-look]').forEach(b=>b.classList.toggle('on',b.dataset.look===look)); dirty=true;
}
document.querySelectorAll('[data-look]').forEach(b=>b.onclick=()=>setLook(b.dataset.look));
document.querySelectorAll('[data-look]').forEach(b=>b.classList.toggle('on',b.dataset.look===look));
$('showFloor').addEventListener('change',e=>{ floor.visible=e.target.checked; lsSet('posedoll:floor',e.target.checked?'1':'0'); dirty=true; });
$('showGrid').addEventListener('change',e=>{ grid.visible=e.target.checked; });
$('fov').addEventListener('input',e=>{ camera.fov=+e.target.value; camera.updateProjectionMatrix(); $('of').textContent=e.target.value+'°'; dirty=true; saveCamLocal(); });

// reference image
const refImg=$('refImg'); let refURL=null;
$('refLoad').onclick=()=>$('refFile').click();
$('refFile').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f) return;
  if(refURL) URL.revokeObjectURL(refURL); refURL=URL.createObjectURL(f);
  refImg.onload=()=>{ ['refClear','refShow','refOp','refFit','refRatio'].forEach(id=>$(id).disabled=false); $('refShow').checked=true; refImg.hidden=false; layoutFrame(); toast('参照画像を読み込みました'); };
  refImg.src=refURL;
  e.target.value='';
});
$('refClear').onclick=()=>{ refImg.hidden=true; refImg.removeAttribute('src'); if(refURL) URL.revokeObjectURL(refURL); refURL=null; ['refClear','refShow','refOp','refFit','refRatio'].forEach(id=>$(id).disabled=true); };
$('refShow').addEventListener('change',e=>{ refImg.hidden=!e.target.checked; });
$('refOp').addEventListener('input',e=>{ refImg.style.opacity=e.target.value; $('oRefOp').textContent=Math.round(e.target.value*100)+'%'; });
$('refFit').addEventListener('change',e=>{ refImg.style.objectFit=e.target.value; });
refImg.style.opacity='0.6';
$('refRatio').onclick=()=>{
  if(!refImg.naturalWidth) return; const a=refImg.naturalWidth/refImg.naturalHeight, area=1024*1024;
  const W=Math.max(256,Math.round(Math.sqrt(area*a)/64)*64), H=Math.max(256,Math.round(Math.sqrt(area/a)/64)*64);
  $('sizeSel').value='custom'; $('customRow').hidden=false; $('cw').value=W; $('ch').value=H; layoutFrame(); toast(`出力サイズを ${W}×${H} にしました`);
};

// camera views
const VIEWS={front:[0,0],q:[40,0],side:[90,0],back:[180,0],high:[25,40],low:[20,-22]};
const VIEW_LABEL={front:'正面',q:'斜め',side:'横',back:'背面',high:'俯瞰',low:'あおり'};
const VIEW_FILE={front:'front',q:'quarter',side:'side',back:'back',high:'high',low:'low'};
function viewPose(name){   // camera position / target that frames the active figure from a named view
  const [az,el]=VIEWS[name], h=wpos(active.J.hips), t=new THREE.Vector3(h.x,0.9*active.body.height,h.z);
  const d=1.25*Math.max(1,active.body.height)/Math.tan(camera.fov*D2R/2);
  return {target:t,pos:new THREE.Vector3(t.x+d*Math.cos(el*D2R)*Math.sin(az*D2R),t.y+d*Math.sin(el*D2R),t.z+d*Math.cos(el*D2R)*Math.cos(az*D2R))};
}
function setView(name){
  const v=viewPose(name); orbit.target.copy(v.target); camera.position.copy(v.pos);
  camera.lookAt(v.target); orbit.update(); dirty=true;
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
let camSaveT; orbit.addEventListener('change',()=>{ dirty=true; clearTimeout(camSaveT); camSaveT=setTimeout(saveCamLocal,400); });

// camera state (kept out of undo; saved in scene files, library items and localStorage 'posedoll:cam')
function getCam(){
  const r=v=>Math.round(v*1000)/1000;
  return {pos:camera.position.toArray().map(r),target:orbit.target.toArray().map(r),fov:Math.round(camera.fov),size:outSize()};
}
function setCam(c,withSize=true){
  if(!c||typeof c!=='object') return false;
  const ok=a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
  if(Number.isFinite(c.fov)){ const v=clamp(Math.round(c.fov),12,70); camera.fov=v; camera.updateProjectionMatrix(); $('fov').value=v; $('of').textContent=v+'°'; }
  if(withSize&&Array.isArray(c.size)&&c.size.length===2&&c.size.every(Number.isFinite)){
    const [W,H]=c.size.map(v=>clamp(Math.round(v),64,4096)), opt=`${W}x${H}`;
    if([...$('sizeSel').options].some(o=>o.value===opt)){ $('sizeSel').value=opt; $('customRow').hidden=true; }
    else { $('sizeSel').value='custom'; $('customRow').hidden=false; $('cw').value=W; $('ch').value=H; }
    layoutFrame();
  }
  if(ok(c.target)) orbit.target.fromArray(c.target);
  if(ok(c.pos)) camera.position.fromArray(c.pos);
  camera.lookAt(orbit.target); orbit.update(); dirty=true; saveCamLocal(); return true;
}
function saveCamLocal(){ lsSet('posedoll:cam',JSON.stringify(getCam())); }
const sceneFile=()=>({...getScene(),cam:getCam()});

// export framing
function outSize(){
  if($('sizeSel').value==='custom') return [clamp(Math.round(+$('cw').value||832),64,4096),clamp(Math.round(+$('ch').value||1216),64,4096)];
  return $('sizeSel').value.split('x').map(Number);
}
function frameRect(){
  const [W,H]=outSize(), a=W/H, m=Math.max(18,Math.min(vw,vh)*0.05);
  const aw=vw-2*m, ah=vh-2*m-60; let w,h;
  if(aw/ah>a){h=ah;w=h*a;}else{w=aw;h=w/a;}
  return {x:(vw-w)/2,y:(vh-h)/2+10,w,h};
}
function layoutFrame(){
  const r=frameRect(), [W,H]=outSize();
  for(const el of [$('frame'),refImg]) Object.assign(el.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});
  $('frameLabel').textContent=W+'×'+H;
  const pc=$('opPreview'), pw=Math.round(Math.min(240,300*W/H)); pc.width=pw; pc.height=Math.round(pw*H/W); dirty=true;
}
$('sizeSel').addEventListener('change',()=>{ $('customRow').hidden=$('sizeSel').value!=='custom'; layoutFrame(); saveCamLocal(); });
['cw','ch'].forEach(id=>$(id).addEventListener('input',()=>{ layoutFrame(); saveCamLocal(); }));
function exportCam(src=camera){ const r=frameRect(), c=src.clone(); c.aspect=vw/vh; c.setViewOffset(vw,vh,r.x,r.y,r.w,r.h); c.updateProjectionMatrix(); c.updateMatrixWorld(); return c; }

// OpenPose drawing (as controlnet_aux draws it)
const LIMBS=[[1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]];
const COLORS=[[255,0,0],[255,85,0],[255,170,0],[255,255,0],[170,255,0],[85,255,0],[0,255,0],[0,255,85],[0,255,170],[0,255,255],[0,170,255],[0,85,255],[0,0,255],[85,0,255],[170,0,255],[255,0,255],[255,0,170],[255,0,85]];
const HAND_EDGES=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20]];
function hsv(h){ const i=Math.floor(h*6)%6, f=h*6-Math.floor(h*6), q=1-f, t=f; const c=[[1,t,0],[q,1,0],[0,1,t],[0,q,1],[t,0,1],[1,0,q]][i]; return c.map(x=>Math.round(x*255)); }
function drawOpenPose(ctx,W,H,cam,hands){
  ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
  const proj=p=>{ const v=p.clone().project(cam); return v.z>1?null:[(v.x+1)/2*W,(1-v.y)/2*H]; };
  const stick=Math.max(2,Math.round(Math.min(W,H)/200));
  for(const f of figures){
    if(!f.group.visible) continue;
    const {pts,vis}=f.kpBody(cam); const p2=pts.map(proj);
    LIMBS.forEach(([a,b],i)=>{
      if(!vis[a]||!vis[b]||!p2[a]||!p2[b]) return;
      const [x1,y1]=p2[a],[x2,y2]=p2[b], len=Math.hypot(x2-x1,y2-y1);
      ctx.save(); ctx.globalAlpha=0.6; ctx.fillStyle=`rgb(${COLORS[i]})`;
      ctx.translate((x1+x2)/2,(y1+y2)/2); ctx.rotate(Math.atan2(y2-y1,x2-x1));
      ctx.beginPath(); ctx.ellipse(0,0,len/2,stick,0,0,Math.PI*2); ctx.fill(); ctx.restore();
    });
    p2.forEach((p,i)=>{ if(!p||!vis[i]) return; ctx.fillStyle=`rgb(${COLORS[i]})`; ctx.beginPath(); ctx.arc(p[0],p[1],stick,0,Math.PI*2); ctx.fill(); });
    if(!hands) continue;
    const lw=Math.max(1,Math.round(Math.min(W,H)/400)), pr=Math.max(2,Math.round(Math.min(W,H)/280));
    for(const s of ['L','R']){
      const h2=f.kpHand(s).map(proj); if(h2.some(p=>!p)) continue;
      ctx.lineWidth=lw; ctx.lineCap='round';
      HAND_EDGES.forEach(([a,b],i)=>{ ctx.strokeStyle=`rgb(${hsv(i/HAND_EDGES.length)})`; ctx.beginPath(); ctx.moveTo(...h2[a]); ctx.lineTo(...h2[b]); ctx.stroke(); });
      ctx.fillStyle='rgb(0,0,255)'; h2.forEach(p=>{ ctx.beginPath(); ctx.arc(p[0],p[1],pr,0,Math.PI*2); ctx.fill(); });
    }
  }
}

// OpenPose keypoint JSON (same points as the image; pixel coords, hidden points are [0,0,0])
function openposeJSON(opts={}){
  const [W,H]=opts.size||outSize(), cam=opts.cam||exportCam(), hands=$('opHands').checked;
  const proj=p=>{ const v=p.clone().project(cam); return v.z>1?null:[(v.x+1)/2*W,(1-v.y)/2*H]; };
  const flat=(pts,vis)=>pts.flatMap((p,i)=>p&&(!vis||vis[i])?[Math.round(p[0]*100)/100,Math.round(p[1]*100)/100,1]:[0,0,0]);
  const people=[];
  for(const f of figures){
    if(!f.group.visible) continue;
    const {pts,vis}=f.kpBody(cam);
    const hand=s=>{ if(!hands) return null; const h=f.kpHand(s).map(proj); return h.some(p=>!p)?null:flat(h); };
    people.push({pose_keypoints_2d:flat(pts.map(proj),vis),hand_left_keypoints_2d:hand('L'),hand_right_keypoints_2d:hand('R'),face_keypoints_2d:null});
  }
  return {people,canvas_width:W,canvas_height:H};
}
const jsonBlob=o=>new Blob([JSON.stringify(o)],{type:'application/json'});

// offscreen render
let xr=null;
function getXR(W,H){ if(!xr){ xr=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true}); xr.setPixelRatio(1); } xr.setSize(W,H,false); return xr; }
const depthMat=new THREE.ShaderMaterial({uniforms:{uNear:{value:1},uFar:{value:5}},
  vertexShader:`#include <common>
#include <skinning_pars_vertex>
varying float vZ; void main(){
#include <skinbase_vertex>
#include <begin_vertex>
#include <skinning_vertex>
vec4 mv=modelViewMatrix*vec4(transformed,1.0); vZ=-mv.z; gl_Position=projectionMatrix*mv; }`,   // skinning chunks: the human look is a SkinnedMesh
  fragmentShader:`uniform float uNear; uniform float uFar; varying float vZ; void main(){ float t=clamp((vZ-uNear)/(uFar-uNear),0.0,1.0); gl_FragColor=vec4(vec3(mix(1.0,0.22,t)),1.0); }`});
const normalMat=new THREE.MeshNormalMaterial();   // view-space normals packed as RGB (x right = R, y up = G, toward camera = B)
function toCanvas(src,W,H){ const c=document.createElement('canvas'); c.width=W; c.height=H; c.getContext('2d').drawImage(src,0,0,W,H); return c; }
function renderImage(kind,opts={}){
  const [W,H]=opts.size||outSize(), cam=opts.cam||exportCam();
  const hidden=[]; if(opts.only) for(const f of figures) if(f!==opts.only&&f.group.visible){ f.group.visible=false; hidden.push(f); }
  const restoreFigs=()=>hidden.forEach(f=>f.group.visible=true);
  if(kind==='openpose'){ const c=document.createElement('canvas'); c.width=W; c.height=H; drawOpenPose(c.getContext('2d'),W,H,cam,$('opHands').checked); restoreFigs(); return c; }
  if(kind==='lineart'){ restoreFigs(); return lineArt(W,H,cam,opts); }
  for(const f of figures) f.syncSkin(true);
  const r=getXR(W,H), keepSel=sel, propsVis=propRoot.visible, gizVis=gizmo.visible;
  sel=null; applyHighlight(); helpers.visible=false; ikGroup.visible=false; gizmo.visible=false;
  propRoot.visible=$('incProps').checked&&!opts.only;
  if(kind==='depth'){
    scene.updateMatrixWorld(true);
    const box=new THREE.Box3(); for(const f of figures) if(f.group.visible) f.meshes.forEach(m=>box.expandByObject(m));
    if(propRoot.visible) props.forEach(p=>p.meshes.forEach(m=>box.expandByObject(m)));
    const cp=wpos(cam), dir=cam.getWorldDirection(V3()), ds=[];
    for(let i=0;i<8;i++) ds.push(new THREE.Vector3(i&1?box.max.x:box.min.x,i&2?box.max.y:box.min.y,i&4?box.max.z:box.min.z).sub(cp).dot(dir));
    depthMat.uniforms.uNear.value=Math.max(0.01,Math.min(...ds)); depthMat.uniforms.uFar.value=Math.max(...ds);
    scene.overrideMaterial=depthMat; r.setClearColor(0x000000,opts.raw?0:1);
  } else if(kind==='normal'){ scene.overrideMaterial=normalMat; r.setClearColor(0x8080ff,opts.raw?0:1); }
  else r.setClearColor(0xffffff,(opts.opaque||!$('transparent').checked)?1:0);
  r.render(scene,cam);
  const out=toCanvas(r.domElement,W,H);
  scene.overrideMaterial=null; helpers.visible=true; ikGroup.visible=ikOn; gizmo.visible=gizVis; propRoot.visible=propsVis;
  restoreFigs(); sel=keepSel; applyHighlight();
  return out;
}
// line art: edges of the silhouette, depth jumps and normal creases, drawn white on black (as lineart / canny preprocessors output)
function lineArt(W,H,cam,opts){
  const o={...opts,size:[W,H],cam,raw:true};
  const pix=k=>renderImage(k,o).getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data;
  const N=pix('normal'), Dp=pix('depth');
  const edge=new Uint8Array(W*H);
  const diff=(i,j)=>{
    const a=N[i*4+3]>127, b=N[j*4+3]>127; if(a!==b) return true; if(!a) return false;
    if(Math.abs(Dp[i*4]-Dp[j*4])>10) return true;
    const dx=N[i*4]-N[j*4], dy=N[i*4+1]-N[j*4+1], dz=N[i*4+2]-N[j*4+2];
    return dx*dx+dy*dy+dz*dz>70*70;   // about 30° between neighbouring normals
  };
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i=y*W+x;
    if(x+1<W&&diff(i,i+1)){ edge[i]=1; edge[i+1]=1; }
    if(y+1<H&&diff(i,i+W)){ edge[i]=1; edge[i+W]=1; }
  }
  const rad=Math.floor(Math.min(W,H)/1000), c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d'), img=ctx.createImageData(W,H), d=img.data;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    let on=edge[y*W+x];
    for(let oy=-rad;!on&&oy<=rad;oy++) for(let ox=-rad;!on&&ox<=rad;ox++){ const xx=x+ox, yy=y+oy; if(xx>=0&&yy>=0&&xx<W&&yy<H&&edge[yy*W+xx]) on=1; }
    const k=(y*W+x)*4, v=on?255:0; d[k]=d[k+1]=d[k+2]=v; d[k+3]=255;
  }
  ctx.putImageData(img,0,0); return c;
}
const blobOf=c=>new Promise(res=>c.toBlob(res,'image/png'));

// local folders (File System Access API: Chrome / Edge). Handles are remembered in IndexedDB.
const FS_OK=typeof window.showDirectoryPicker==='function';
const dirs={lib:null,out:null}, dirsPending={lib:null,out:null};
function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open('posedoll',1); r.onupgradeneeded=()=>r.result.createObjectStore('kv'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function kv(mode,k,v){
  try{ const db=await idb(); return await new Promise((res,rej)=>{ const t=db.transaction('kv',mode==='get'?'readonly':'readwrite'), st=t.objectStore('kv');
    const q=mode==='get'?st.get(k):mode==='set'?st.put(v,k):st.delete(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }
  catch(e){ return null; }
}
async function restoreDir(kind){
  const h=await kv('get','dir_'+kind); if(!h) return;
  try{ if(await h.queryPermission({mode:'readwrite'})==='granted') dirs[kind]=h; else dirsPending[kind]=h; }catch(e){}
}
async function pickDir(kind){
  try{ const h=await window.showDirectoryPicker({id:'posedoll_'+kind,mode:'readwrite'}); dirs[kind]=h; dirsPending[kind]=null; await kv('set','dir_'+kind,h); refreshDirUI(); return h; }
  catch(e){ if(e&&e.name!=='AbortError') toast('フォルダを開けませんでした（'+(e.message||e.name)+'）'); return null; }
}
async function ensureDir(kind){
  if(dirs[kind]) return dirs[kind];
  const h=dirsPending[kind]; if(!h) return null;
  try{ if(await h.requestPermission({mode:'readwrite'})==='granted'){ dirs[kind]=h; dirsPending[kind]=null; refreshDirUI(); return h; } }catch(e){}
  return null;
}
async function forgetDir(kind){ dirs[kind]=null; dirsPending[kind]=null; await kv('del','dir_'+kind); refreshDirUI(); }
async function writeFile(dir,name,data){ const fh=await dir.getFileHandle(name,{create:true}); const w=await fh.createWritable(); await w.write(data); await w.close(); }
const safeName=s=>String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,' ').trim().slice(0,40)||'pose';
function refreshDirUI(){
  for(const kind of ['lib','out']){
    const h=dirs[kind]||dirsPending[kind];
    $(kind+'DirName').textContent=h?`📁 ${h.name}${dirs[kind]?'':'（接続待ち）'}`:(kind==='out'?'ブラウザのダウンロード':'未設定');
    $(kind+'Resume').hidden=!(dirsPending[kind]&&!dirs[kind]);
    $(kind+'Clear').hidden=!h;
    $(kind+'Pick').hidden=!FS_OK;
  }
  if(!FS_OK) $('libWhere').textContent='このブラウザはフォルダ保存に対応していないため、ブラウザ内に保存します（Chrome または Edge で開くとフォルダに保存できます）。';
  else if(dirs.lib) $('libWhere').textContent=`ポーズは「${dirs.lib.name}」フォルダに1件ずつJSONファイルとして保存されます。`;
  else if(dirsPending.lib) $('libWhere').textContent='前回のフォルダに接続するには「接続を再開」を押してください（ブラウザの確認が出ます）。';
  else $('libWhere').textContent='「フォルダを選ぶ」でポーズの保存先を決めてください。最初の保存時に選んでもかまいません。';
}

// saving files: chosen output folder, otherwise the browser's download
async function saveFile(filename,blob,kind='out'){
  const dir=kind==='out'?await ensureDir('out'):null;
  if(dir){
    try{ await writeFile(dir,filename,blob); toast(`「${dir.name}」に保存しました：${filename}`); return; }
    catch(e){ toast('フォルダに書き込めなかったため、ダウンロードで保存します'); }
  }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000); toast('ダウンロードしました：'+filename);
}
function stamp(){ const d=new Date(),p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
async function saveKind(kind){ const [W,H]=outSize(); await saveFile(`pose_${stamp()}_${W}x${H}_${kind}.png`,await blobOf(renderImage(kind))); }
$('saveDoll').onclick=()=>saveKind('doll');
$('saveOP').onclick=()=>saveKind('openpose');
$('saveDepth').onclick=()=>saveKind('depth');
$('saveNormal').onclick=()=>saveKind('normal');
$('saveLine').onclick=()=>saveKind('lineart');
$('saveKP').onclick=()=>{ const [W,H]=outSize(); saveFile(`pose_${stamp()}_${W}x${H}_keypoints.json`,jsonBlob(openposeJSON())); };
$('saveZip').onclick=async()=>{
  if(!window.JSZip){ toast('ZIP機能を読み込めませんでした。個別に保存してください'); return; }
  const [W,H]=outSize(), s=stamp(), z=new JSZip();
  for(const k of ['doll','openpose','depth','normal','lineart']) z.file(`pose_${s}_${W}x${H}_${k}.png`,await blobOf(renderImage(k)));
  z.file(`pose_${s}_${W}x${H}_keypoints.json`,JSON.stringify(openposeJSON()));
  z.file(`pose_${s}_scene.json`,JSON.stringify(sceneFile(),null,1));
  await saveFile(`pose_${s}_${W}x${H}.zip`,await z.generateAsync({type:'blob'}));
};
// multi-angle batch: the chosen views x the chosen outputs into one ZIP (the on-screen camera is not touched)
const BATCH_KINDS=['doll','openpose','depth','normal','lineart','keypoints'];
function viewCam(name){ const v=viewPose(name), c=camera.clone(); c.position.copy(v.pos); c.lookAt(v.target); c.updateMatrixWorld(); return exportCam(c); }
async function batchZip(views,kinds){
  const [W,H]=outSize(), s=stamp(), z=new JSZip();
  for(const v of views){
    const cam=viewCam(v), base=`pose_${s}_${W}x${H}_${VIEW_FILE[v]}`;
    for(const k of kinds){
      if(k==='keypoints') z.file(`${base}_keypoints.json`,JSON.stringify(openposeJSON({cam})));
      else z.file(`${base}_${k}.png`,await blobOf(renderImage(k,{cam})));
    }
  }
  z.file(`pose_${s}_scene.json`,JSON.stringify(sceneFile(),null,1));
  return {name:`pose_${s}_${W}x${H}_angles.zip`,z};
}
(function buildBatchUI(){
  const vb=$('batchViews'), kb=$('batchKinds'), KL={doll:'人形',openpose:'OpenPose',depth:'深度',normal:'法線',lineart:'線画',keypoints:'キーポイント'};
  let saved={}; try{ saved=JSON.parse(lsGet('posedoll:batch')||'{}')||{}; }catch(e){}
  const mk=(box,id,label,on)=>{ const l=document.createElement('label'); l.className='check'; l.innerHTML=`<input type="checkbox" id="${id}">`; l.append(label); l.firstChild.checked=on; box.append(l); };
  Object.keys(VIEWS).forEach(v=>mk(vb,'bv_'+v,VIEW_LABEL[v],saved.views?saved.views.includes(v):['front','q','side','back'].includes(v)));
  BATCH_KINDS.forEach(k=>mk(kb,'bk_'+k,KL[k],saved.kinds?saved.kinds.includes(k):['doll','openpose'].includes(k)));
  const sel=()=>({views:Object.keys(VIEWS).filter(v=>$('bv_'+v).checked),kinds:BATCH_KINDS.filter(k=>$('bk_'+k).checked)});
  const upd=()=>{ const c=sel(); $('saveBatch').disabled=!c.views.length||!c.kinds.length; $('saveBatch').textContent=`一括保存（${c.views.length}方向×${c.kinds.length}種類・ZIP）`; lsSet('posedoll:batch',JSON.stringify(c)); };
  vb.addEventListener('change',upd); kb.addEventListener('change',upd); upd();
  $('saveBatch').onclick=async()=>{
    if(!window.JSZip){ toast('ZIP機能を読み込めませんでした'); return; }
    const c=sel(), btn=$('saveBatch'); btn.disabled=true; const label=btn.textContent; btn.textContent='書き出し中…';
    try{ const {name,z}=await batchZip(c.views,c.kinds); await saveFile(name,await z.generateAsync({type:'blob'})); }
    finally{ btn.textContent=label; upd(); }
  };
})();
$('saveJson').onclick=()=>saveFile(`pose_${stamp()}_scene.json`,new Blob([JSON.stringify(sceneFile(),null,1)],{type:'application/json'}));
$('loadJson').onclick=()=>$('fileIn').click();
$('fileIn').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f) return;
  try{ const s=JSON.parse(await f.text()); if(!(s.figures||s.rot)) throw 0; setScene(s); commit(); const c=s.cam&&$('loadCam').checked&&setCam(s.cam); toast(c?'シーンと視点を読み込みました':'シーンを読み込みました'); }
  catch(err){ toast('読み込めませんでした。このアプリで保存したシーンのJSONを選んでください'); }
  e.target.value='';
});
let tt; function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(tt); tt=setTimeout(()=>t.classList.remove('show'),2600); }

// pose library: one JSON file per pose in the chosen folder (localStorage when folders are unsupported)
let lib=[], libReady=false;
function loadLocalLib(){ try{ lib=JSON.parse(lsGet('posedoll:lib')||'[]'); }catch(e){ lib=[]; } }
function saveLocalLib(){ lsSet('posedoll:lib',JSON.stringify(lib)); }
async function reloadLib(){
  if(!FS_OK){ loadLocalLib(); libReady=true; renderLib(); return; }
  if(!dirs.lib){ lib=[]; libReady=true; renderLib(); return; }
  const out=[];
  try{
    for await (const [name,h] of dirs.lib.entries()){
      if(h.kind!=='file'||!name.toLowerCase().endsWith('.json')) continue;
      try{ const j=JSON.parse(await (await h.getFile()).text()); if(j&&j.pose) out.push({...j,id:name}); }catch(e){}
    }
  }catch(e){ toast('保存先フォルダを読めませんでした'); }
  out.sort((a,b)=>(b.created||0)-(a.created||0)); lib=out; libReady=true; renderLib();
}
async function initLib(){ await Promise.all([restoreDir('lib'),restoreDir('out')]); refreshDirUI(); await reloadLib(); }
function renderLib(){
  const box=$('libList'); box.innerHTML='';
  if(!libReady){ box.innerHTML='<div class="empty">読み込んでいます…</div>'; return; }
  if(!lib.length){ box.innerHTML='<div class="empty">保存したポーズはまだありません。ポーズを作って名前を付けて「保存」すると、ここにサムネイル付きで並びます。</div>'; return; }
  const grid=document.createElement('div'); grid.className='lib';
  for(const it of lib){
    const d=document.createElement('div'); d.className='lib-item';
    const img=document.createElement('img'); img.alt=''; if(typeof it.thumb==='string'&&it.thumb.startsWith('data:image/')) img.src=it.thumb;
    const nm=document.createElement('div'); nm.className='nm'; nm.textContent=it.name||'無題';
    const dt=document.createElement('div'); dt.className='dt'; dt.textContent=it.created?new Date(it.created).toLocaleDateString('ja-JP'):'';
    const row=document.createElement('div'); row.className='row';
    const bl=document.createElement('button'); bl.textContent='読み込む'; bl.onclick=()=>loadLibItem(it);
    const bd=document.createElement('button'); bd.textContent='削除'; let armed=false, tm;
    bd.onclick=()=>{ if(!armed){ armed=true; bd.textContent='本当に削除'; bd.classList.add('warn'); tm=setTimeout(()=>{armed=false; bd.textContent='削除'; bd.classList.remove('warn');},3000); return; } clearTimeout(tm); deleteLibItem(it); };
    row.append(bl,bd); d.append(img,nm,dt,row); grid.append(d);
  }
  box.append(grid);
}
function makeThumb(){
  const tw=120, th=160; active.group.updateMatrixWorld(true);
  const box=new THREE.Box3(); active.meshes.forEach(m=>box.expandByObject(m));
  const sph=box.getBoundingSphere(new THREE.Sphere()), c=new THREE.PerspectiveCamera(30,tw/th,0.05,100);
  const half=Math.min(15*D2R,Math.atan(Math.tan(15*D2R)*tw/th)), dir=camera.getWorldDirection(V3());
  c.position.copy(sph.center).addScaledVector(dir,-sph.radius/Math.sin(half)*0.78); c.lookAt(sph.center); c.updateMatrixWorld();
  return renderImage('doll',{size:[tw,th],only:active,opaque:true,cam:c}).toDataURL('image/jpeg',0.75);
}
async function addLibEntry(e){
  if(!FS_OK){ lib.unshift({id:'l'+Date.now()+Math.random().toString(36).slice(2,6),...e}); saveLocalLib(); renderLib(); return true; }
  let dir=await ensureDir('lib'); if(!dir) dir=await pickDir('lib'); if(!dir) return false;
  const body=JSON.stringify({posedollPose:1,...e});
  let fname=`${stamp()}_${safeName(e.name)}.json`;
  try{ await writeFile(dir,fname,body); }
  catch(err){   // some file systems refuse non-ASCII names: retry with a plain name (the pose name stays inside the file)
    try{ fname=`${stamp()}_pose.json`; await writeFile(dir,fname,body); }
    catch(err2){ toast('フォルダに保存できませんでした（'+(err2&&(err2.message||err2.name))+'）'); return false; }
  }
  lib.unshift({...e,id:fname}); renderLib(); return true;
}
$('libSave').onclick=async()=>{
  const name=$('libName').value.trim()||`ポーズ ${lib.length+1}`;
  const ok=await addLibEntry({name,created:Date.now(),pose:active.getPose(),body:{...active.body},cam:camRel(),thumb:makeThumb()});
  if(ok){ $('libName').value=''; toast(`「${name}」を保存しました`); }
};
$('libName').addEventListener('keydown',e=>{ if(e.key==='Enter') $('libSave').click(); });
// library cameras are stored relative to the figure's hips so they follow the figure wherever it stands
function camRel(){ const h=wpos(active.J.hips), c=getCam(), r=v=>Math.round(v*1000)/1000; c.pos=c.pos.map((v,i)=>r(v-h.getComponent(i))); c.target=c.target.map((v,i)=>r(v-h.getComponent(i))); c.rel='hips'; return c; }
function loadLibItem(it){
  if(!it.pose) return; const cur=active.J.hips.position.clone();
  if($('libBody').checked&&it.body){ active.body={...BODY_DEF,...it.body}; active.applyBody(); refreshBodyUI(); }
  const root=it.pose.root||[0,0.97,0];
  active.setPose({rot:it.pose.rot||{},root:[cur.x,root[1],cur.z]});
  syncSliders(); commit();
  let camMsg='';
  if($('libCam').checked&&it.cam&&it.cam.rel==='hips'){ active.group.updateMatrixWorld(true); const h=wpos(active.J.hips), add=a=>Array.isArray(a)?a.map((v,i)=>v+h.getComponent(i)):a; if(setCam({...it.cam,pos:add(it.cam.pos),target:add(it.cam.target)},false)) camMsg='（視点も反映）'; }
  toast(`「${it.name}」を${active.name}に読み込みました${camMsg}`);
}
async function deleteLibItem(it){
  if(!FS_OK){ lib=lib.filter(x=>x.id!==it.id); saveLocalLib(); renderLib(); return; }
  const dir=await ensureDir('lib'); if(!dir) return;
  try{ await dir.removeEntry(it.id); lib=lib.filter(x=>x.id!==it.id); renderLib(); toast(`「${it.name}」を削除しました`); }catch(e){ toast('削除できませんでした'); }
}
for(const kind of ['lib','out']){
  $(kind+'Pick').onclick=async()=>{ if(await pickDir(kind)&&kind==='lib') reloadLib(); };
  $(kind+'Resume').onclick=async()=>{ if(await ensureDir(kind)&&kind==='lib') reloadLib(); };
  $(kind+'Clear').onclick=async()=>{ await forgetDir(kind); if(kind==='lib') reloadLib(); };
}
$('libReload').onclick=async()=>{ await ensureDir('lib'); reloadLib(); };
$('libExport').onclick=()=>{ const items=lib.map(({id,...r})=>r); saveFile(`pose_library_${stamp()}.json`,new Blob([JSON.stringify({posedollLibrary:1,items})],{type:'application/json'})); };
$('libImport').onclick=()=>$('libFile').click();
$('libFile').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f) return; e.target.value='';
  try{ const j=JSON.parse(await f.text()); const items=Array.isArray(j)?j:j.items; if(!Array.isArray(items)) throw 0;
    let n=0; for(const it of items){ if(!it||!it.pose) continue; const e={name:String(it.name||'無題').slice(0,40),created:+it.created||Date.now(),pose:it.pose,body:it.body||{},thumb:typeof it.thumb==='string'?it.thumb:''}; if(it.cam&&typeof it.cam==='object') e.cam=it.cam; if(await addLibEntry(e)) n++; }
    toast(`${n}件のポーズを取り込みました`);
  }catch(err){ toast('取り込めませんでした。書き出した保存庫のJSONを選んでください'); }
});

// keyboard
function stepJoint(dir){   // next / previous joint: body joints, or the fingers of the selected hand
  const n=sel?.kind==='joint'?sel.name:null, list=n&&n.startsWith('f')?FINGER_JOINTS(n[1]):BODY_JOINTS;
  const i=list.indexOf(n), j=i<0?(dir>0?0:list.length-1):(i+dir+list.length)%list.length;
  select({kind:'joint',fig:active,name:list[j]});
}
let keyCommitT;
function nudgeJoint(axis,deg){
  if(sel?.kind!=='joint') return false;
  const r=sel.fig.J[sel.name].rotation; r[axis]+=deg*D2R; clampJoint(sel.fig,sel.name);
  syncSliders(); dirty=true; clearTimeout(keyCommitT); keyCommitT=setTimeout(commit,400); return true;
}
function setGizmoMode(m){   // 'rotate' | 'translate' | 'scale'
  if(sel?.kind==='prop'){ propMode=m; select(sel); return; }
  if(sel?.kind==='joint'&&sel.name==='hips'&&m!=='scale'){ moveMode=m==='translate'; select(sel); return; }
  if(m==='translate'&&sel?.kind==='joint') toast('移動できるのは「腰（全体）」と小道具だけです');
}
const VIEW_KEYS=['front','q','side','back','high','low'];
addEventListener('keydown',e=>{
  const t=e.target, typing=(t.tagName==='INPUT'&&t.type!=='range'&&t.type!=='checkbox')||t.tagName==='TEXTAREA';
  if(typing) return;
  const onCtl=t.tagName==='SELECT'||(t.tagName==='INPUT'&&t.type==='range');   // let sliders / selects keep their own keys
  const free=t===document.body||t===renderer.domElement||t===document.documentElement;
  const k=e.key.toLowerCase(), mod=e.ctrlKey||e.metaKey;
  if(mod&&k==='z'){ e.preventDefault(); e.shiftKey?redo():undo(); }
  else if(mod&&k==='y'){ e.preventDefault(); redo(); }
  else if(k==='escape') select(null);
  else if((k==='delete'||k==='backspace')&&sel?.kind==='prop'){ e.preventDefault(); deleteProp(); }
  else if(e.altKey||onCtl) return;
  else if((k==='tab'&&free)||k===']'||k==='['){ e.preventDefault(); stepJoint(k==='['||e.shiftKey?-1:1); }
  else if(!mod&&k==='r') setGizmoMode('rotate');
  else if(!mod&&k==='g') setGizmoMode('translate');
  else if(!mod&&k==='s'&&sel?.kind==='prop') setGizmoMode('scale');
  else if(!mod&&/^[1-6]$/.test(k)) setView(VIEW_KEYS[+k-1]);
  else if(k.startsWith('arrow')){
    const st=e.shiftKey?5:1, ax=k==='arrowup'||k==='arrowdown'?'x':(mod?'y':'z'), sg=k==='arrowup'||k==='arrowright'?1:-1;
    if(nudgeJoint(ax,sg*st)) e.preventDefault();
  }
});
$('undo').onclick=undo; $('redo').onclick=redo;

// loop
function resize(){ const r=stage.getBoundingClientRect(); vw=Math.max(1,r.width); vh=Math.max(1,r.height); renderer.setSize(vw,vh,false); camera.aspect=vw/vh; camera.updateProjectionMatrix(); layoutFrame(); }
new ResizeObserver(resize).observe(stage);
const pctx=$('opPreview').getContext('2d');
function loop(){
  requestAnimationFrame(loop);
  orbit.update(); updateHandles();
  const fine=performance.now()-bodyEditAt>350; for(const f of figures) f.syncSkin(fine);
  renderer.render(scene,camera);
  if(dirty){ dirty=false; const pc=$('opPreview'); drawOpenPose(pctx,pc.width,pc.height,exportCam(),$('opHands').checked); }
}
$('opHands').addEventListener('change',()=>dirty=true);

// boot
limitsOn=lsGet('posedoll:lim')!=='0'; $('tLim').classList.toggle('on',limitsOn);
ikOn=lsGet('posedoll:ik')==='1'; $('tIK').classList.toggle('on',ikOn);
if(lsGet('posedoll:floor')==='1'){ $('showFloor').checked=true; floor.visible=true; }
let boot=null; try{ boot=JSON.parse(lsGet('posedoll:v2')||lsGet('posedoll:last')||'null'); }catch(e){}
if(boot) setScene(boot);
if(!figures.length){ const f=createFigure(); f.setState(defaultFigureState(0)); f.ground(); active=f; }
if(!active) active=figures[0];
syncHandles(); refreshFigUI(); select(null);
undoStack=[JSON.stringify(getScene())]; updUndo();
resize(); setView('front');
{ let c=null; try{ c=JSON.parse(lsGet('posedoll:cam')||'null'); }catch(e){} if(c) setCam(c); }
showTab(lsGet('posedoll:tab')||'pose');
renderLib(); initLib();
loop();
window.__pose={THREE,applyLLM,llmPrompt,solvePole,solveElbow,setLook,getLook:()=>look,camera:()=>camera,figures:()=>figures,active:()=>active,getScene,setScene,getCam,setCam,batchZip,getSel:()=>sel,sceneFile,openposeJSON,applyPreset,renderImage,select,setView,solveLimb,mirrorPose,limitsFor,clampJoint,addProp,setFinger,setSpread,commit,
  setIK:v=>{ ikOn=v; syncHandles(); }, setLimits:v=>{ limitsOn=v; }};
