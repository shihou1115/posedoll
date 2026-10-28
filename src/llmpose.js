// 自然言語ポーズ（v1.5）: LLM が書いた「意味の名前つき」ポーズ JSON を、アプリの関節角（XZY オイラー、度）に直す。
// three.js 非依存。指示書（LLM に渡す説明）は llm_prompt.md。
import PROMPT from './llm_prompt.md';
export { PROMPT };

// 本人の左側での向き: 項目名 → [軸, 符号]。右側はアプリ側で (x,-y,-z) に鏡写しする
const TRUNK={bend:['x',1],nod:['x',1],lean:['x',1],turn:['y',1],twist:['y',1],tilt:['z',-1],side:['z',-1]};
const MAP={
  hips:TRUNK, spine:TRUNK, chest:TRUNK, neck:TRUNK, head:TRUNK,
  shoulder:{front:['x',-1],raise:['x',-1],side:['z',1],abduct:['z',1],rotate:['y',1],twist:['y',1]},
  elbow:{bend:['x',-1],rotate:['y',1],twist:['y',1]},
  wrist:{bend:['z',-1],side:['x',-1]},
  hip:{front:['x',-1],raise:['x',-1],side:['z',1],abduct:['z',1],rotate:['y',1],twist:['y',1]},
  knee:{bend:['x',1]},
  ankle:{point:['x',1],bend:['x',1]},
};
export const HAND_NAMES={open:'開く',relaxed:'リラックス',relax:'リラックス',fist:'グー',peace:'ピース',point:'指さし',pointing:'指さし',
  ok:'OK',flat:'そろえる',grip:'つかむ',grab:'つかむ',hold:'つかむ'};

// 「left_shoulder」「Shoulder_L」「l_elbow」なども関節名に直す
const BASES=['hips','spine','chest','neck','head','shoulder','elbow','wrist','hip','knee','ankle'];
export function jointKey(k){
  if(/^(hips|spine|chest|neck|head|(shoulder|elbow|wrist|hip|knee|ankle)[LR]|f[LR]_\w+\d)$/.test(k)) return k;
  let s=String(k).toLowerCase().replace(/[\s_\-.]/g,''), side=null;
  const m=s.match(/^(left|right|l|r)(.+)$/)||s.match(/^(.+?)(left|right|l|r)$/);
  if(m){ const [a,b]=/^(left|right|l|r)$/.test(m[1])?[m[1],m[2]]:[m[2],m[1]]; if(BASES.includes(b)&&b!=='hips'){ side=a[0]==='l'?'L':'R'; s=b; } }
  if(s==='pelvis'||s==='root'||s==='body') s='hips';
  if(s==='waist'||s==='abdomen'||s==='belly') s='spine';
  if(s==='thigh') s='hip'; if(s==='arm'||s==='upperarm') s='shoulder'; if(s==='forearm') s='elbow'; if(s==='leg') s='hip'; if(s==='foot') s='ankle';
  if(['hips','spine','chest','neck','head'].includes(s)) return side?null:s;
  return BASES.includes(s)&&side?s+side:null;
}

// コードブロック・前後の文章・// コメント・末尾のカンマがあっても読む
export function parseLoose(text){
  let t=String(text).trim(); const fence=t.match(/```(?:json)?\s*([\s\S]*?)```/i); if(fence) t=fence[1];
  const a=t.indexOf('{'), b=t.lastIndexOf('}'); if(a<0||b<a) throw new Error('JSON が見つかりません');
  t=t.slice(a,b+1);
  try{ return JSON.parse(t); }catch(e){}
  t=t.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,(m,str)=>str||'').replace(/,\s*([}\]])/g,'$1').replace(/'/g,'"');
  return JSON.parse(t);
}

// → {rot:{関節:[x,y,z]度}, hands:{L,R}(HAND_PRESETS の名前), lift, name, warn:[...]}
export function llmToPose(o){
  const pose=o.pose||o.joints||o.rot||o, rot={}, warn=[];
  for(const k in pose){
    if(['posedoll','name','hands','lift'].includes(k)&&!o.pose) continue;
    const j=jointKey(k), v=pose[k]; if(!j){ warn.push(k); continue; }
    if(Array.isArray(v)){ rot[j]=[0,1,2].map(i=>+v[i]||0); continue; }   // そのままの関節角
    const base=j.startsWith('f')?null:j.replace(/[LR]$/,''), map=MAP[base]; if(!map||typeof v!=='object'){ warn.push(k); continue; }
    const e={x:0,y:0,z:0};
    for(const f in v){ const m=map[String(f).toLowerCase()]; const n=+v[f]; if(!m||!isFinite(n)){ warn.push(k+'.'+f); continue; } e[m[0]]+=m[1]*n; }
    rot[j]=j.endsWith('R')&&base!==j?[e.x,-e.y,-e.z]:[e.x,e.y,e.z];
  }
  const hands={};
  for(const [s,v] of Object.entries(o.hands||{})){
    const side=/^l/i.test(s)?'L':/^r/i.test(s)?'R':null, name=HAND_NAMES[String(v).toLowerCase()]||v;
    if(side) hands[side]=name; else warn.push('hands.'+s);
  }
  return {rot,hands,lift:Math.max(0,+o.lift||0),name:o.name||'',warn};
}
