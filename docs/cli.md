# GameUI Studio CLI

CLI 直接调用现有 `/api/*`，或在本机运行与网页相同的透明组件像素算法。不依赖浏览器自动化，也不引入新的模型供应商、密钥存储或生产部署机制。

## 安装与入口

使用 Node.js 20+，在项目根目录运行 `npm ci`，包含开发依赖。共享 TypeScript 算法由仓库已有的 TypeScript 编译器加载；PNG 和 ZIP 使用已有的 sharp、JSZip。没有新增 npm 依赖，也没有发布独立 npm 包。

```sh
npm run cli -- help
node scripts/gameui.mjs health --json
npm run check:cli
```

用于管道时使用 `node scripts/gameui.mjs ... --json` 或 `npm run --silent cli -- ... --json`，避免 npm 的启动提示混入 stdout。CLI 脚本可由绝对路径从其他目录调用；输入和输出路径相对于调用时的工作目录。

## 启动与连接

```sh
npm run cli -- serve --host 127.0.0.1 --port 5174
# 在另一个终端执行：
node scripts/gameui.mjs health --url http://127.0.0.1:5174 --json
node scripts/gameui.mjs health --url http://127.0.0.1:5174 --segment --json
node scripts/gameui.mjs models --url http://127.0.0.1:5174 --json
```

`serve` 在前台启动现有 Vite 配置与 API，Ctrl+C/SIGTERM 关闭。它会切换到项目根目录，保持 `.env.local`、`.data` 的位置与 `npm run dev` 一致；不会安装或下载模型，也不是生产服务器、Site 发布或后台守护进程。端口占用会报错，不会悄悄换端口。`npm run preview` 没有后端 API，不能作为 CLI 服务端。

通用配置：

| 选项 / 环境变量 | 说明 |
| --- | --- |
| `--url` / `GAMEUI_URL` | 服务地址，默认 `http://127.0.0.1:5173`；支持反向代理路径前缀 |
| `--timeout` | 每次 HTTP 请求总时限，默认 300000ms；范围 1–3600000ms |
| `--json` | stdout 仅输出一个 JSON 对象；错误诊断写 stderr |
| `--force` | 允许覆盖普通输出文件；不覆盖符号链接或已有输出目录 |
| `--allow-http` | 显式允许非 loopback 地址的明文 HTTP；默认要求远端 HTTPS |
| `GAMEUI_TOKEN` | 可选反向代理 Bearer token，仅发给指定服务，不写入输出文件 |

`GAMEUI_TOKEN` **不会为现有服务增加认证**。现有 Vite API 不能因此直接暴露公网；公开访问需要独立认证、访问控制和持久化方案。客户端拒绝 HTTP 重定向，以免把凭据转发到其他地址。

普通 `health` 证明 API 可达，并返回 `health.gateway` 的真实布尔值；网关离线时，透明图集离线拆分仍可用。加 `--segment` 后，SAM runtime 不可用会返回退出码 3。模型名通过 `models` 查询，视觉命令可选 `--model`；生图使用服务自身配置，不接受虚构的模型覆盖参数。

## 图片到风格、线稿、效果图

以下远端命令需要已启动服务。可用 `--url` 或 `GAMEUI_URL` 指向它。

```sh
node scripts/gameui.mjs upload --input style.png --json
node scripts/gameui.mjs style --input style.png --out style.json --json
node scripts/gameui.mjs layout --input screenshot.png --out output-layout --json
node scripts/gameui.mjs generate --wireframe output-layout/wireframe.png --style style.json --style-image style.png --out effect.png --json
```

`style` 可重复 `--reference other.png`，总计最多 12 张，也可只传 `--description "圆润森林手绘"`。输出 JSON 包含 `name`、`prompt` 与参考图信息。

`detect --input screenshot.png --out elements.json` 只生成素材清单与原图像素矩形。`layout` 使用同一识别结果产生：

- `elements.json`：原图像素坐标及文字策略。
- `layout.json`：`nodes` 与归一化矩形，可以供布局导入代码消费。
- `wireframe.svg`、`wireframe.png`：按这些矩形绘制的几何线稿，不是 AI 重新绘图，也不是网页 Canvas 渲染器的逐像素复刻。

所有输入经过 EXIF 方向规范化，坐标相对于规范化后的展示图片。输入支持单帧 PNG/JPEG/WebP，20 MB、4000 万像素以内；风格参考接口上限为 16777216 像素。

`generate` 可用 `--prompt` 或 `--prompt-file instructions.txt`（二选一），`--size 1080x1920` 指定请求尺寸；默认使用线稿尺寸。实际模型返回的大小会明确报告，保留原图，不强行裁切或拉伸。

这些命令不会自动创建项目、版本、画风库或切图任务记录。上传的参考图及 `/api/generate` 返回的整图按现有接口保存在服务端；CLI 的分析结果、线稿及切图文件保存在指定本地路径。

## AI 重绘与算法切图必须分开

### AI 重新生成透明素材表

```sh
node scripts/gameui.mjs ai-sheet --input effect.png --out sheet.png --json
```

调用 `/api/ai-slice-sheet`。默认要求去掉已有文字、数字、描边和投影并补回底材，保留有意义的图形符号；会生成新像素，可能改变造型。不保证所有文字都已删除。可用 `--prompt-file` 替换要求；仍需人工检查。

### 离线拆分已经透明的素材表

```sh
node scripts/gameui.mjs slice-sheet --input sheet.png --out output-assets --zip --json
```

不连接服务、不调用模型。直接复用 `src/lib/alphaComponents.ts` 的 `analyzeAlphaSheetPixels`，保留分配给每个组件的 RGBA 像素。输出：`png/Component001.png` 等独立图片、`source.png`、`manifest.json`、`diagnostics.json`，加 `--zip` 时额外输出 `candidates.zip`。

所有候选 `approved: false`，属于人工审核包，**不是“自动审核通过的游戏资源包”**。透明检查会拒绝烘焙在图片里的棋盘格或整张不透明截图。孤立低透明度残片会报告，不默默丢失原图。图集坐标标为 `sheet`，不推断原界面位置；CLI 不会推断输入图到底是 AI 重绘还是原生美术。

### 从截图分割一个目标

```sh
node scripts/gameui.mjs segment --input effect.png --rect 50,80,240,160 --kind panel --out output-panel --json
# 可选点选文件：[{"x":100,"y":120,"label":1},{"x":260,"y":100,"label":0}]
node scripts/gameui.mjs segment --input effect.png --rect 50,80,240,160 --points points.json --out output-panel-with-points --json
```

先上传原图，再调用现有 `/api/segment`。需要服务端已安装 SAM runtime；CLI 不替代 SAM，也不自动安装 PyMatting。输出 `sprite.png`、全尺寸 `full-rgba.png`、`mask.png` 和诊断 `manifest.json`。

按 v2 协议的 `outputBounds` 裁剪，不裁回旧提示框；采用服务返回的完整 RGBA，不把精修 RGB 换回原图。质量状态 `failed` 时仍保存证据，但返回退出码 5；精修降级与触边问题保留在诊断中。SAM 本身不负责删除控件内部文字。

## 不经过模型网关的测试 / 外部 Agent 工作流

```sh
node scripts/gameui.mjs style --input style.png --dry-run --json > style-request.json
node scripts/gameui.mjs layout --input screenshot.png --dry-run --json > layout-request.json
node scripts/gameui.mjs generate --wireframe output-layout/wireframe.png --style style.json --dry-run --json > render-request.json
```

`--dry-run` 只输出请求计划、提示词和参考文件路径/尺寸/规范 PNG 哈希，不上传图片、不写 `--out`、不调用 API 或模型。由外部 Agent 或当前会话独立产生结果后，可显式导入：

```sh
node scripts/gameui.mjs style --input style.png --response external-style.json --out style.json --json
node scripts/gameui.mjs layout --input screenshot.png --response external-elements.json --out output-layout --json
node scripts/gameui.mjs generate --wireframe output-layout/wireframe.png --response external-effect.png --out effect.png --json
node scripts/gameui.mjs ai-sheet --input effect.png --response external-sheet.png --out sheet.png --json
node scripts/gameui.mjs slice-sheet --input sheet.png --out output-assets --zip --json
```

外部风格 JSON 格式为 `{"name":"森林","prompt":"画风描述"}`。外部识别 JSON 格式为：

```json
{"elements":[{"label":"CurrencyPanel","kind":"panel","x":50,"y":20,"w":300,"h":60,"layer":1,"description":"blank gold panel","textPolicy":"separate"}]}
```

`kind` 可为 `panel/button/icon/text/progress/frame/decor`。也接受 `rect:{x,y,w,h}` 或 `bbox:[left,top,right,bottom]`；不会为缺失坐标编造默认尺寸。`--response` 与 `--dry-run` 互斥。输出明确标记 `external-analysis` 或 `external-image`；这些模式不会伪称执行了真实模型推理。CLI 不是当前 ChatGPT 会话或子代理的隐式调用接口。

## 读取任务与导出已审核资源

```sh
node scripts/gameui.mjs tasks --json
node scripts/gameui.mjs tasks --id YOUR_TASK_ID --json
node scripts/gameui.mjs export --task YOUR_TASK_ID --out reviewed-assets.zip --module Home --json
node scripts/gameui.mjs download --name SERVER_FILE.png --out downloaded.png --json
```

`export` 仅从已保存的 `/api/slice-tasks` 导出 `approved: true` 且有图片的条目；默认排除 `kind: text`，可显式 `--include-text`。不修改审批状态，不读取未审核图像。ZIP 包含 `png/`、`manifest.json`、`coords.json`；PNG 保持服务端原始文件字节，清单验证其展示尺寸。

文件名限制为安全字符并去重；清单记录来源、重绘与处理状态。`sheet` 坐标的 `originalScreenRect` 为 `null`，避免误当原界面位置。CLI ZIP 不生成 Unity 导入脚本或自动推断九宫格；需要这些网页导出附加功能时使用已有网页导出入口。

## 错误、费用与文件安全

`--json` 成功输出 `{"ok":true,"command":"...","data":{...}}`；失败输出 `{"ok":false,"error":{"code":"...","message":"...","details":{...}},"exitCode":3}`。错误详情只在存在时附带。

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令完成；候选素材仍可能待审核，不能把 0 等同于美术验收通过 |
| 1 | 文件系统或其他执行错误 |
| 2 | 参数、输入、输出冲突错误 |
| 3 | 网络、服务依赖、HTTP 或响应协议错误 |
| 4 | HTTP 请求超时 |
| 5 | 质量失败、无可导出素材、图集不透明或资源限额错误 |

客户端不自动重试任何请求。图像命令使用现有同步 API，超时不能证明服务端停止，也不能保证没有计费。超时/网络错误中的 `mayHaveBeenSubmitted: true` 提醒先检查服务端；已有持久化图片可用 `download` 取回。`ai-sheet` 的现有同步接口没有可恢复任务 ID；CLI 没有伪造恢复机制。

输出文件默认拒绝覆盖，`--force` 只适用于普通文件。目录输出要求目标目录不存在，写入临时目录完成后再发布；失败时清理自身临时文件，不删除用户原有目录。不要用自动重跑整个生成命令代替单纯的本地文件恢复。

## 回归测试

```sh
npm run check:cli
```

测试启动真实 Node CLI 子进程、localhost HTTP 受控服务、PNG/ZIP 编解码，验证共享算法的像素归属、软边、扩框、审核过滤、非法输入、文件冲突、凭据脱敏、重定向阻止和超时不重试。模拟返回的模型/SAM 响应明确标记为受控数据，不调用真实网关、不下载模型。

`serve` 的正常启动还依赖完整仓库的 Vite 及服务依赖；专项测试只覆盖其非法端口拒绝，不代替真实 Vite 启动验收。CLI 专项通过也不替代整仓 `npm run build`、网页回归或真实模型质量验收。
