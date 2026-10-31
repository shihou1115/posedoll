"""tools/blender_import.py の検証。Blender の中で実行する。
    exec(open(r"C:\\claude\\posedoll\\tests\\blender\\run_check.py", encoding="utf-8").read())
cases/*.scene.json を新しいシーンに読み込み、Blender が計算した位置（ノード・点・顔）と、
Blender のカメラでの画像上の位置を、アプリが出した正解 cases/*.ref.json と比べる。結果は results.json。
"""
import json, os, glob, math
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else r"C:\claude\posedoll\tests\blender"
exec(open(os.path.join(HERE, '..', '..', 'tools', 'blender_import.py'), encoding='utf-8').read())
KEEP = globals().get('POSEDOLL_KEEP', set())   # 残しておくケース名（見た目の確認用）

def run():
    to_three = Y_UP_TO_Z_UP.inverted()
    res = {'blender': bpy.app.version_string, 'cases': {}}
    for sp in sorted(glob.glob(os.path.join(HERE, 'cases', '*.scene.json'))):
        case = os.path.basename(sp)[:-len('.scene.json')]
        ref = json.load(open(sp[:-len('.scene.json')] + '.ref.json', encoding='utf-8'))
        b = import_posedoll(sp, new_scene=True, name='pdchk_' + case)
        sc = b['scene']; sc.view_layers[0].update()
        W, H = sc.render.resolution_x, sc.render.resolution_y
        def px(wb):
            q = world_to_camera_view(sc, b['camera'], wb)
            return [q.x * W, (1 - q.y) * H]
        dw, dp, worst = [], [], ('', 0.0)
        def cmp(label, wb, r):
            nonlocal worst
            w3 = to_three @ wb
            e = (w3 - Vector(r['w'])).length; dw.append(e)
            p = px(wb); ep = math.hypot(p[0] - r['px'][0], p[1] - r['px'][1]); dp.append(ep)
            if ep > worst[1]: worst = (label, ep)
        for fi, rf in enumerate(ref['figures']):
            for n, r in rf['nodes'].items(): cmp(f'{fi}:{n}', b['figures'][fi][n].matrix_world.translation, r)
            for k, r in rf['marks'].items(): cmp(f'{fi}:{k}', b['marks'][fi][k].matrix_world.translation, r)
            fo = b['face'][fi]
            for i, r in enumerate(rf['face']): cmp(f'{fi}:face{i}', fo.matrix_world @ fo.data.vertices[i].co, r)
        res['cases'][case] = {'points': len(dw), 'maxWorld_mm': max(dw) * 1000, 'maxPx': max(dp),
                              'meanPx': sum(dp) / len(dp), 'worst': worst[0], 'size': [W, H],
                              'shift': [b['camera'].data.shift_x, b['camera'].data.shift_y]}
        if case not in KEEP:
            coll = b['collection']
            for o in list(coll.objects):
                d = o.data; bpy.data.objects.remove(o)
                if d is not None and d.users == 0:
                    (bpy.data.meshes if isinstance(d, bpy.types.Mesh) else bpy.data.cameras).remove(d)
            for m in list(bpy.data.meshes):
                if m.users == 0 and m.name.startswith('pdchk_'): bpy.data.meshes.remove(m)
            bpy.data.collections.remove(coll); bpy.data.scenes.remove(sc)
    res['pass'] = all(c['maxWorld_mm'] < 1.0 and c['maxPx'] < 0.5 for c in res['cases'].values())
    json.dump(res, open(os.path.join(HERE, 'results.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    return res

RESULT = run()
print(json.dumps(RESULT, ensure_ascii=False, indent=1))
