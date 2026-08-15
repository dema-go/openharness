# OpenHarness 视觉设计:漫画风(《阿衰》式)

## 来源与流程

1. **需求**:用户要求前端改成彩色漫画风,类似《阿衰》漫画;
2. **设计引擎**:使用 Open Design(nexu-io/open-design)× DeepSeek Harness —— 经 `dsh --profile open-design --stdio` 官方 JSONL 协议驱动 deepseek-v4-pro 生成;
3. **产物**:`design/cartoon-mockup.html`(单文件静态设计稿)+ 角色/配色/组件规范;
4. **落地**:工程师将设计体系移植到 React + Tailwind CSS v4(本目录上层 packages/web)。

## 设计体系(已落地)

| 令牌 | 值 | 用途 |
|---|---|---|
| --color-page | `#FFF3D6` | 漫画纸底 |
| --color-panel | `#FFFDF6` | 白色漫画格 |
| --color-ink | `#221D15` | 墨色:文字、3px 描边、硬实影 |
| --color-red/yellow/cyan/purple/green/blue/pink/orange | 高饱和撞色 | 徽章/图表/状态 |
| Agent 识别色 | cursor=`#FF4433` claude=`#FF9F1C` codex=`#00C2DC` dsh=`#8B4DFF` | 特工卡/头像/事件归属 |

- **描边/实影**:3px 墨线 + 硬偏移阴影(3/5/8px,零模糊),按压位移反馈;
- **字体**:站酷快乐体(中文手绘)/ Luckiest Guy(英文漫画字标)/ IBM Plex Mono(数据);
- **纹理**:网点纸(radial-gradient)、爆炸星、火花、波浪线。

## 角色设定(Open Design 生成)

| Agent | 角色名 | 设定 |
|---|---|---|
| Cursor | 光标侠 | 番茄红机器人 + 光标箭头,编辑器内改文件 |
| Claude Code | 小克 | 漫画橙机器人 + 太阳花天线,工程编排担当 |
| Codex | 码星人 | 电光青机器人 + 护目镜 + 闪电天线,沙箱实验员 |
| DeepSeek Harness | 鲸酱 | 弹力紫小鲸鱼,深度复盘担当 |

头像为内联 SVG(`packages/web/src/components/ComicIcons.tsx`),状态以对话气泡表达(待命/干活/未接入),火花条随事件点亮(签名元素)。
