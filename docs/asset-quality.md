# 素材质量与验证

所有命令均在仓库根目录执行。新处理结果默认待审核；测试通过不等于任意截图都能自动恢复成完整游戏资源。

## 两条处理路径

| 路径 | 处理方式 | 需要检查的内容 |
| --- | --- | --- |
| 原图提取 | SAM2 在带上下文的局部区域推理，保留已有多候选及正负点；可选 PyMatting 估计连续 alpha 和前景颜色 | 目标是否完整、是否包含邻居、细小装饰与透明孔是否正确 |
| AI 拆图 | 图像模型重绘透明组件表，再按像素归属拆成素材 | 是否漏件或改画、文字是否按要求处理、是否有真正 alpha、各组件是否独立 |

SAM2 只能分割已有可见像素。压在底板中的文字、被其他控件遮挡的图案，需要局部修复或重绘。AI 拆图的文字策略是生成要求，不能保证文字一定清除；导出前仍需查看结果。

局部 AI 补图回填时会按可信 alpha 主体确定内容范围，远处的孤立低透明噪点不会把主体挤小。返回多个独立主体时会报告失败并保留旧切片，新的有效像素仍需重新审核。

透明组件表会保留原始 RGBA；相连软边不会因为固定透明度阈值被硬切掉。多个主体共享半透明支撑区域时会分别归属并提示复查。孤立、低透明度且覆盖量很小的残片不会生成独立素材，诊断会列出数量，原始组件表仍保留这些像素。

## 本地运行时与可选精修

SAM2 服务使用以下固定位置，源码和权重不会自动下载：

| 内容 | 路径 |
| --- | --- |
| Windows Python | `.venv-seg/Scripts/python.exe` |
| Linux / macOS Python | `.venv-seg/bin/python` |
| SAM2 源码 | `.data/segmentation/sam2/source/` |
| 既有隔离依赖目录 | `.data/segmentation/sam2/site/` |
| SAM 2.1 small 权重 | `.data/segmentation/sam2/sam2.1_hiera_small.pt` |
| 配置 | `configs/sam2.1/sam2.1_hiera_s.yaml` |
| 可选 PyMatting 依赖 | `.data/matting/site/` |

按 [SAM2 官方安装说明](https://github.com/facebookresearch/sam2#installation) 准备与本机 Python 匹配的依赖及权重。服务当前使用 CPU；原有 `site` 目录需存在，依赖也可由该虚拟环境提供。`--health` 只检查导入，不会执行权重推理。

PyMatting 不需要图像生成网关或额外模型权重。使用与 `.venv-seg` 相同的 Python 安装其依赖；已有虚拟环境时跳过创建步骤。

### Linux / macOS

```sh
python3 -m venv .venv-seg
.venv-seg/bin/python -m pip install --target .data/matting/site -r scripts/requirements-matting.txt
.venv-seg/bin/python scripts/test-segmentation-refinement.py
```

### Windows PowerShell

```powershell
py -3 -m venv .venv-seg
& .\.venv-seg\Scripts\python.exe -m pip install --target .data/matting/site -r scripts/requirements-matting.txt
& .\.venv-seg\Scripts\python.exe scripts/test-segmentation-refinement.py
```

仅安装 PyMatting 可以运行精修回归；使用界面中的 SAM2 局部分割还需准备上表的 SAM2 运行时。

## 如何理解输出

- **待审核**：结果没有自动获得批准。查看白底和深色底，重点检查文字、细线、阴影、透明孔与四角。
- **`refinement.status = degraded`**：本次未完成真实 matting。依赖缺失、区域过大、前景／背景种子不足或数值求解失败都会给出原因；输出仍保留可检查的粗蒙版。
- **`quality.status = failed`**：检测到提示点冲突、推理边界截断或异常扩张等问题。先调整框选或正负点，再重新提取。
- **`source-alpha`**：保留已有透明度与前景颜色。若原生透明区域与邻居相连，只恢复可信边缘，并显示限制原因，不会通过透明桥重新带回已排除内容。

二值 mask 与精修 RGBA 分开保存。SAM 输入临时合成中性底，避免透明像素的隐藏 RGB 干扰识别；该背景不会写入输出素材。

`promptBounds` 是提示框，`inferenceBounds` 是带上下文的推理区域，`maskBounds` 是选中目标范围，`outputBounds` 包含精修软边和透明留边。四者都是原图中的整数 `xyxy` 坐标，右／下边界不包含在区域内。素材 `rect` 使用最终输出范围，可能比提示框更大；这是为保留边缘，不应强行改回旧框。

AI 拆图素材标记为 `coordinateSpace: sheet`。它们的坐标属于组件表，不能直接当作原界面的放置坐标；需要在原图上定位后再用于界面还原。Sprite 图集自身的打包坐标与原界面布局坐标是两件不同的事。

## 离线回归

先执行 `npm ci`。以下 JavaScript 命令在 Linux 与 Windows 均可执行，使用项目已有 esbuild 编译 TypeScript，避免依赖 Node 的原生 TypeScript 支持：

```sh
npx --no-install esbuild scripts/test-alpha-sheet-quality.mjs --bundle --platform=node --format=esm --outfile=node_modules/.cache/alpha-sheet-quality.mjs
node node_modules/.cache/alpha-sheet-quality.mjs
node scripts/test-segmentation-api.mjs
npm run typecheck
```

API 回归会监听本机临时端口，使用受控的 Python 子进程输出；不会启动 SAM 推理、调用 Magpie 或其他模型服务。Python 精修回归使用已知前景、背景与 alpha 的合成图，真实运行本地 PyMatting，并在不同背景上比较重合成误差：

```sh
# Linux / macOS
.venv-seg/bin/python scripts/test-segmentation-refinement.py
```

```powershell
# Windows PowerShell
& .\.venv-seg\Scripts\python.exe scripts/test-segmentation-refinement.py
```

`npm run check` 的离线检查和这些协议／像素回归不需要 Magpie。既有 `npm run check:model` 是另行显式执行的真实图像模型探测，会调用配置的 Magpie 图像服务并可能收费；本轮没有执行该命令。

### 浏览器和局部补图回归

`npm run check` 包含无需浏览器的像素与协议逻辑检查。局部补图浏览器回归已加入 `npm run check:web`，也可单独执行；它用真实 Canvas 验证局部参考裁剪、带透明留白和离群噪点的长条回填、审核状态，以及组件表的整页导出坐标。以下两个脚本在 Windows 默认使用 Edge，其他环境可以指定已安装的 Chromium 可执行文件：

```sh
GAMEUI_BROWSER_EXECUTABLE=/path/to/chromium node scripts/test-asset-repair.mjs
GAMEUI_BROWSER_EXECUTABLE=/path/to/chromium node scripts/test-ai-slice-browser.mjs
```

浏览器测试拦截模型请求，测试图片不会发给模型服务。原生图像能力生成的图集是另一组真实输入验收，不能把受控 HTTP 响应视为真实模型推理结果。

AI 拆图浏览器测试默认使用 9 组件合成透明图；可用自己的真实 RGBA 图替换（该回归样例预期 9 个主体），验证原始图集保存、像素归属、审核前后 ZIP 与刷新恢复：

```sh
GAMEUI_BROWSER_EXECUTABLE=/path/to/chromium GAMEUI_AI_SHEET_FIXTURE=/absolute/path/sheet.png node scripts/test-ai-slice-browser.mjs
```

### 真实 SAM2 检查

准备好运行时后，可以直接对自己的 PNG 发起一次本地请求。请将示例路径和框坐标改成实际文件及其原图像素坐标。

Linux / macOS：

```sh
.venv-seg/bin/python scripts/segment.py --health
printf '%s\n' '{"imagePath":"/absolute/path/ui.png","bbox":[20,30,220,180],"kind":"icon","output":"files"}' | .venv-seg/bin/python scripts/segment.py
```

Windows PowerShell：

```powershell
& .\.venv-seg\Scripts\python.exe scripts/segment.py --health
$segmentRequest = @{
    imagePath = "C:\images\ui.png"
    bbox = @(20, 30, 220, 180)
    kind = "icon"
    output = "files"
}
$segmentRequest | ConvertTo-Json -Compress | & .\.venv-seg\Scripts\python.exe scripts/segment.py
```

`output: files` 会返回二值 mask、RGBA 文件路径与质量诊断。进程成功退出只表示请求完成，还需检查 `quality`、`refinement` 和实际图像。

旧的 `segment-check.py` 使用固定本机样本，而非任意图片自检。它需要 `.data/images/screen-1793144933666-c4z2yw.png`、`.data/segmentation/official-manifest.json`、清单记录的权重与相应依赖；这些文件不包含在仓库中。已有该完整数据集时执行：

```sh
# Linux / macOS
.venv-seg/bin/python scripts/segment-check.py
```

```powershell
# Windows PowerShell
& .\.venv-seg\Scripts\python.exe scripts/segment-check.py
```

缺少历史样本时，使用前面的 `segment.py` 请求检查自己的输入，不要把跳过历史数据集记为真实 SAM 质量验收通过。

## 本轮验证记录（2026-10-30）

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| Python 精修回归 | 11 项通过 | 实际 PyMatting、已知合成层、原生 alpha、提示框与输出框、降级和邻居排除 |
| API / 客户端回归 | 35 项通过 | 实际 HTTP 与存储；Python 输出受控、客户端 Canvas 为测试替身 |
| 透明组件表与色键回归 | 26 项通过 | 像素归属、软边、独立组件、残片记录、透明背景与原生 RGB |
| 两张原生图像能力生成的 RGBA 组件表 | 各输出 9 个资产 | 1708×921；输出与诊断残片的像素计数守恒，检查白底／深色底结果 |
| 真实浏览器局部补图与整页导出 | 8 组通过 | 实际 Canvas、PNG、ZIP；局部参考、透明留白、软尾、多主体失败、审核状态、坐标空间 |
| 真实 RGBA 图集的完整浏览器流程 | 通过 | 第二张原生图集：9 资产、850 个残片像素有诊断；保存原图集，审核前 0 / 审核后 9 项导出，刷新恢复 |

这两张实际组件表用于验证拆分流程，没有逐像素人工真值，也不是原截图的原始分层文件。本轮没有安装或运行真实 SAM 权重，因此不能据此宣布 SAM 端到端效果已验收。它们及导出的对照图保存在本轮工作产物中，不是仓库自带测试数据；新的输入仍需单独检查。

`npm run build` 和 `npm run check:integration` 已通过。完整 `npm run check` 已执行，切图相关检查通过后，在既有 `test-versions.mjs` 中因 `ReferenceError: onSaveVersion is not defined` 停止；基线提交 `9e71372a3773da670512666e873604896f59e3f7` 的 App 已无该动作，旧测试仍调用它，本次没有重写版本功能或跳过这个失败。之后的布局、风格和边界测试已单独运行通过。完整离线门禁不能记为全绿。
