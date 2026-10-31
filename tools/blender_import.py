"""デッサン人形ポーザーのシーン JSON（posedoll-scene 2.1）を Blender に読み込む。

使い方（Blender の Scripting タブ、または blender --python）:
    exec(open(r"C:\\claude\\posedoll\\tools\\blender_import.py", encoding="utf-8").read())
    import_posedoll(r"C:\\path\\to\\xxx_scene.json")              # 今のシーンに追加
    import_posedoll(r"...json", new_scene=True)                    # 新しいシーンを作って読み込む

作るもの:
- 「posedoll」空オブジェクト（X 軸まわり +90°。three.js の +Y 上を Blender の +Z 上へ移す）
- 人物ごとに基準の空オブジェクト（位置・身長の拡大）と、骨格の各ノードの空オブジェクト
  （関節は回転モード YZX ＝ アプリの XZY と同じ。回転をいじればポーズを直せる）
- 骨の棒（親ノードの子のメッシュ。ビューポートで線として見える）、OpenPose の点（空オブジェクト）、顔の 68 点（メッシュ）
- 小道具（部品ごとの箱・円柱メッシュ）
- カメラ（書き出し画像と同じ画角・縦横比・レンズシフト・解像度）

座標の約束は docs/scene-format.md を参照。Blender 4.x / 5.x で動作確認。
"""
import json
import math

import bpy
from mathutils import Euler, Matrix, Vector

# three.js (Y 上) → Blender (Z 上): (x, y, z) → (x, -z, y)
Y_UP_TO_Z_UP = Matrix.Rotation(math.radians(90.0), 4, 'X')
# three.js の Euler 'XZY'（行列 Rx·Rz·Ry）は Blender の回転モード 'YZX'（Y→Z→X の順に回す）と同じ
JOINT_MODE = 'YZX'
# three.js の既定 'XYZ'（行列 Rx·Ry·Rz）は Blender の 'ZYX'
PROP_MODE = 'ZYX'

D2R = math.pi / 180.0


def _rad(v):
    return [a * D2R for a in v]


def _link(obj, coll, parent=None):
    coll.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
    return obj


def _empty(name, coll, parent=None, kind='PLAIN_AXES', size=0.02):
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = kind
    o.empty_display_size = size
    return _link(o, coll, parent)


def _mesh(name, coll, verts, edges=(), faces=(), parent=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], list(edges), list(faces))
    me.update()
    return _link(bpy.data.objects.new(name, me), coll, parent)


def _box_mesh(name):
    v = [(x, y, z) for x in (-.5, .5) for y in (-.5, .5) for z in (-.5, .5)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    return me


def _cyl_mesh(name, n=24):
    # 半径 1・高さ 1、軸 Y（three.js の CylinderGeometry と同じ）
    v = []
    for y in (-.5, .5):
        for i in range(n):
            a = 2 * math.pi * i / n
            v.append((math.sin(a), y, math.cos(a)))
    f = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    f += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    return me


def _look_at(pos, target):
    """three.js の Object3D.lookAt（カメラ用・上 +Y）と同じ回転行列を、three.js の座標のまま作る。"""
    eye, tgt, up = Vector(pos), Vector(target), Vector((0, 1, 0))
    z = eye - tgt
    if z.length < 1e-12:
        z = Vector((0, 0, 1))
    z.normalize()
    x = up.cross(z)
    if x.length < 1e-12:  # 真上・真下を向くとき（three.js と同じ逃がし方）
        if abs(up.z) == 1:
            z.x += 1e-4
        else:
            z.z += 1e-4
        z.normalize()
        x = up.cross(z)
    x.normalize()
    y = z.cross(x)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2] = x[i], y[i], z[i]
    m.translation = eye
    return m


def import_posedoll(path, new_scene=False, name=None, with_bones=True, with_face=True):
    """シーン JSON を読み込む。戻り値は {'scene', 'collection', 'root', 'camera', 'figures': [{name: obj}], 'marks': [...], 'face': [...]}。"""
    with open(path, encoding='utf-8') as fp:
        data = json.load(fp)
    return build_posedoll(data, new_scene=new_scene, name=name, with_bones=with_bones, with_face=with_face)


def build_posedoll(data, new_scene=False, name=None, with_bones=True, with_face=True):
    if data.get('format') != 'posedoll-scene' or not all('skeleton' in f for f in data.get('figures', [])):
        raise ValueError('posedoll-scene 2.1 以降（アプリ v1.7 以降の「シーンを JSON で保存」）のファイルが必要です')
    name = name or 'posedoll'
    if new_scene:
        scene = bpy.data.scenes.new(name)
    else:
        scene = bpy.context.scene
    coll = bpy.data.collections.new(name)
    scene.collection.children.link(coll)

    root = _empty(name, coll, kind='ARROWS', size=0.3)
    root.matrix_basis = Y_UP_TO_Z_UP.copy()
    out = {'scene': scene, 'collection': coll, 'root': root, 'figures': [], 'marks': [], 'face': []}

    for fi, fig in enumerate(data['figures']):
        sk = fig['skeleton']
        tag = f"{name}.{fi + 1}"
        g = _empty(f"{tag}:{fig.get('name', '人物')}", coll, root, kind='CUBE', size=0.05)
        g.location = fig['pos']
        h = fig['body'].get('height', 1)
        g.scale = (h, h, h)
        rot = fig['pose'].get('rot', {})
        objs = {None: g}
        for n, nd in sk['nodes'].items():  # 親が先に並んでいる
            o = _empty(f"{tag}:{n}", coll, objs[nd['parent']], kind='SPHERE' if nd.get('joint') else 'PLAIN_AXES',
                       size=0.012 if n.startswith('f') else 0.025)
            o['posedoll_node'] = n
            o['posedoll_figure'] = fi
            o.location = fig['pose']['root'] if n == 'hips' else nd['offset']
            o.rotation_mode = JOINT_MODE
            o.rotation_euler = Euler(_rad(rot.get(n, [0, 0, 0]) if nd.get('joint') else nd.get('rest', [0, 0, 0])), JOINT_MODE)
            s = nd.get('scale', 1)
            o.scale = (s, s, s)
            objs[n] = o
        if with_bones:  # 親ノードの空間に、子ノードの原点まで線を引く
            kids = {}
            for n, nd in sk['nodes'].items():
                if nd['parent'] and n != 'hips':
                    kids.setdefault(nd['parent'], []).append(nd['offset'])
            for k in sk['marks'].values():
                if k['parent'] != 'headGroup':
                    kids.setdefault(k['parent'], []).append(k['offset'])
            for p, ends in kids.items():
                v = [(0, 0, 0)] + [tuple(e) for e in ends]
                bo = _mesh(f"{tag}:{p}.bone", coll, v, [(0, i) for i in range(1, len(v))], parent=objs[p])
                bo.hide_render = True
        marks = {}
        for k, m in sk['marks'].items():
            o = _empty(f"{tag}:{k}", coll, objs[m['parent']], kind='PLAIN_AXES', size=0.01)
            o['posedoll_mark'] = k
            o['posedoll_figure'] = fi
            o.location = m['offset']
            marks[k] = o
        face = None
        if with_face:
            face = _mesh(f"{tag}:face68", coll, sk['face']['points'], parent=objs[sk['face']['parent']])
            face['posedoll_figure'] = fi
            face.hide_render = True
        out['figures'].append({k: v for k, v in objs.items() if k})
        out['marks'].append(marks)
        out['face'].append(face)

    meshes = {'box': _box_mesh(f"{name}.box"), 'cylinder': _cyl_mesh(f"{name}.cylinder")}
    for pi, pr in enumerate(data.get('props', [])):
        po = _empty(f"{name}.prop{pi + 1}:{pr['type']}", coll, root, kind='PLAIN_AXES', size=0.1)
        po.location = pr['pos']
        po.rotation_mode = PROP_MODE
        po.rotation_euler = Euler(_rad(pr.get('rot', [0, 0, 0])), PROP_MODE)
        po.scale = pr.get('scl', [1, 1, 1])
        for qi, part in enumerate(pr.get('parts', [])):
            q = _link(bpy.data.objects.new(f"{po.name}.{qi}", meshes[part['shape']]), coll, po)
            q.location = part['pos']
            q.scale = part['size']

    cam = data['cam']
    lens = cam['lens']
    W, H = lens['size']
    cd = bpy.data.cameras.new(f"{name}.cam")
    cd.sensor_fit = 'VERTICAL'
    cd.angle_y = lens['fovY'] * D2R
    # Blender のシフトは「合わせる向きの辺（ここでは縦 H）」が単位。視線の軸が NDC の (cx, cy) に来るように逆向きにずらす
    cx, cy = lens['center']
    cd.shift_x = -cx * W / (2.0 * H)
    cd.shift_y = -cy / 2.0
    cd.clip_start, cd.clip_end = 0.01, 100.0
    co = _link(bpy.data.objects.new(f"{name}.cam", cd), coll, root)
    co.matrix_basis = _look_at(cam['pos'], cam['target'])
    scene.camera = co
    r = scene.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    r.pixel_aspect_x = r.pixel_aspect_y = 1.0
    out['camera'] = co
    return out
