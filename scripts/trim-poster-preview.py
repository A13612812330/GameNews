"""移除 Edge 长截图底部的空白背景，保留海报实际内容和底部留白。

⚠️ 已停用（2026-09-28）：流水线改用 `scripts/trim-poster-preview.mjs`（纯 Node，零依赖）。
本机 PATH 上的 `python` 是没有 PIL 的托管解释器，这个脚本在调度环境里必然抛
`ModuleNotFoundError`，而调用方是 try/catch + warn ⇒ 裁边静默失效、12000px 空白画布
被原样上传飞书。**不要在 scheduled-posters.mjs 里改回调用本文件。**
保留此文件仅作算法参照；两种实现的输出已实测逐像素一致。
"""

from pathlib import Path
import sys

from PIL import Image


def is_content_row(image: Image.Image, y: int, background: tuple[int, int, int]) -> bool:
    """判断这一行是否仍有海报内容；兼容顶部渐变、底部纯色纸张背景。"""
    width = image.width
    # 全宽抽样即可稳定识别卡片、边框、阴影，避免 12000px 大图逐像素扫描。
    samples = range(0, width, max(1, width // 180))
    changed = 0
    for x in samples:
        pixel = image.getpixel((x, y))
        if sum(abs(pixel[index] - background[index]) for index in range(3)) > 10:
            changed += 1
            if changed >= 3:
                return True
    return False


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: trim-poster-preview.py <png-path>")

    path = Path(sys.argv[1])
    with Image.open(path) as source:
        image = source.convert("RGB")
        background = image.getpixel((0, image.height - 1))
        last_content = None
        for y in range(image.height - 1, -1, -1):
            if is_content_row(image, y, background):
                last_content = y
                break
        if last_content is None:
            return
        # 保留页面本身的底部呼吸空间；不扩大到固定画布高度。
        bottom = min(image.height, last_content + 73)
        if bottom >= image.height:
            return
        image.crop((0, 0, image.width, bottom)).save(path, "PNG", optimize=True)


if __name__ == "__main__":
    main()
