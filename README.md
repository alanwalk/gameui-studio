# GameUI Studio

本地运行的 AI 游戏 UI 制作工具，连接布局设计、效果图生成、素材提取和资源导出，无需启动 Unity Editor。

## 功能

- **项目与界面管理**：创建、重命名、复制和删除项目与界面，自动保存工作数据。
- **布局编辑**：模板与参考图分析、父子节点树、分组、移动缩放、对齐、撤销与重做。
- **效果图生成**：结合线稿与画风生成 UI，支持微调、版本管理和整图对比。
- **素材编辑**：双画布预览、矩形框选、色键提取、SAM2 局部分割、可选 PyMatting 边缘精修、蒙版修整与素材审核。
- **AI 拆图**：将效果图重绘成透明组件表，按像素归属拆分，保留软边并报告未归属残片；新素材进入待审核状态。
- **画图与画风库**：独立生图、多参考图、画风创建、分析、编辑与复制。
- **资源导出**：透明 PNG、坐标与清单、图集、整页及多界面 ZIP，以及 Unity Sprite 导入脚本。

## 启动

安装 Node.js 与 npm，并单独配置 Magpie CLI、图像模型和视觉模型网关。

```powershell
git clone https://github.com/alanwalk/gameui-studio.git
cd gameui-studio
npm ci
Copy-Item .env.example .env.local
```

在 `.env.local` 配置 Magpie 可执行文件、网关和模型，再运行：

```powershell
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

打开 <http://127.0.0.1:5174/>。工作数据默认保存在 `.data`，API 由 Vite 开发服务提供。`npm run preview` 仅提供静态预览。

详细配置、操作流程和素材导出说明见[使用指南](docs/guide.md)。

## 切图与质量检查

原图提取使用 SAM2 识别目标，可选 PyMatting 估计连续 alpha 和边缘前景颜色。已有透明素材优先保留原生 alpha。输出范围根据目标和软边确定，可能与最初的提示框不同；检测框、输出框及精修状态都会保留在诊断信息中。

AI 拆图会生成新的透明组件表，适合制作去字底板与独立控件；生成内容可能与原图不同。组件表里的坐标属于新图集，需要在原界面重新定位。SAM2 分割本身不负责擦除控件内部文字或补画遮挡内容。

精修不可用时会明确显示降级原因并保留粗蒙版；两条路径的新结果均需审核。安装、Linux / Windows 命令和验证边界见[素材质量与验证](docs/asset-quality.md)。

## 开发

```powershell
npm run typecheck
npm run smoke
npm run build
```

API 回归使用 `npm run check:integration`，浏览器回归使用 `npm run check:web`。部分浏览器测试需要安装 Microsoft Edge。模型探测使用 `npm run check:model`，会调用外部图像服务并可能产生费用。

新增切图回归可单独执行，无需 Magpie 或图像网关：

```sh
npx --no-install esbuild scripts/test-alpha-sheet-quality.mjs --bundle --platform=node --format=esm --outfile=node_modules/.cache/alpha-sheet-quality.mjs
node node_modules/.cache/alpha-sheet-quality.mjs
node scripts/test-segmentation-api.mjs
```

PyMatting 的真实合成层回归还需要本地 Python 依赖，平台命令见[验证说明](docs/asset-quality.md#离线回归)。这些测试不会下载 SAM 权重，也不会发起图像生成。

## 许可证

[MIT](LICENSE)。第三方依赖、模型及外部素材遵循各自许可证。
