"""posedoll.html をビルドする（src/app.js + src/template.html + vendor/ → 1ファイルの HTML）。

使い方:  python src/build.py
必要なもの: esbuild（下の候補から自動で探す。見つからなければ ESBUILD 環境変数でパスを指定）
"""
import os, pathlib, shutil, subprocess, sys

SRC = pathlib.Path(__file__).resolve().parent
ROOT = SRC.parent
VENDOR = ROOT / 'vendor'

def find_esbuild():
    cands = [os.environ.get('ESBUILD'), shutil.which('esbuild'),
             '/opt/npm-tools/node_modules/esbuild/bin/esbuild']
    for c in cands:
        if c and pathlib.Path(c).exists():
            return [c]
    if shutil.which('npx'):
        return ['npx', '--yes', 'esbuild']
    sys.exit('esbuild が見つかりません。ESBUILD 環境変数で実行ファイルのパスを指定してください。')

def main():
    out_js = SRC / 'bundle.js'
    subprocess.run(find_esbuild() + [
        str(SRC / 'app.js'), '--bundle', '--format=iife', '--minify', '--target=chrome110', '--legal-comments=none',
        '--alias:three=./vendor/three.module.min.js',
        '--alias:three-orbit=./vendor/OrbitControls.js',
        '--alias:three-transform=./vendor/TransformControls.js',
        '--loader:.md=text',
        f'--outfile={out_js}'], check=True, cwd=ROOT)
    esc = lambda t: t.replace('</script', '<\\/script')
    bundle = esc(out_js.read_text(encoding='utf-8'))
    jszip = esc((VENDOR / 'jszip.min.js').read_text(encoding='utf-8'))
    tpl = (SRC / 'template.html').read_text(encoding='utf-8')
    assert tpl.count('__BUNDLE__') == 1 and tpl.count('__JSZIP__') == 1, 'template.html の差し込み位置が壊れています'
    html = tpl.replace('__JSZIP__', jszip).replace('__BUNDLE__', bundle)
    (ROOT / 'posedoll.html').write_text(html, encoding='utf-8')
    out_js.unlink()
    # LLM 向けの指示書は、アプリを通さずに使う人（Claude などに直接読ませる）のためにファイルでも置く
    shutil.copyfile(SRC / 'llm_prompt.md', ROOT / 'LLM_POSE.md')
    print(f'posedoll.html を書き出しました（{len(html.encode("utf-8")):,} bytes）')

if __name__ == '__main__':
    main()
