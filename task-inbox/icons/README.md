# 图标

用来做桌面快捷方式和页面 favicon。

```
cabinet-light.ico   浅色（默认用这个）
cabinet-dark.ico    深色
light.png           256×256 原图
dark.png
cabinet-1024.png    1024×1024，macOS 图标源（由 cabinet-pixel-dark.svg 渲染）
trayTemplate.png    macOS 菜单栏模板图 16×16（纯黑 + alpha，去掉深色底）
trayTemplate@2x.png 同上 32×32
```

## 换 logo 时怎么重新生成

1. 把新的 SVG 放到这个目录，命名 `cabinet-pixel-light.svg` / `cabinet-pixel-dark.svg`
2. 跑 `make-icon.ps1`（在 task-inbox 目录下），它会用 Chrome headless 渲染成 PNG
3. 把 PNG 包成 ICO：

```python
import struct
def make_ico(src, out):
    png = open(src,'rb').read()
    w,h = struct.unpack('>II', png[16:24])
    header = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII', 0 if w>=256 else w, 0 if h>=256 else h,
                        0, 0, 1, 32, len(png), 22)
    open(out,'wb').write(header + entry + png)

make_ico('light.png', 'cabinet-light.ico')
make_ico('dark.png', 'cabinet-dark.ico')
```

4. 跑 `mklinks.cmd` 重建桌面快捷方式

## 为什么用 ICO 而不是 SVG

Windows 的资源管理器和任务栏只认 `.ico` / `.png`，不认 SVG。
`.url` 快捷方式的 `IconFile` 字段同理。
