---
name: arknights-audio
description: 明日方舟音频 AssetBundle 转 WAV —— 把游戏里的 .ab 音频文件（UnityFS + 方舟魔改 LZ4 "LZ4AK" + FMOD FSB5 容器）解码成可播放的 WAV。当用户要求转换/提取/解码明日方舟(含 B 服)的音乐、音效、语音 .ab 文件时使用。
whenToUse: 用户给出明日方舟游戏目录下 audio 路径的 .ab 文件或目录，要求转成能听的音频(WAV)时；也可用于批量转换整个音乐/音效文件夹。
---

# 明日方舟音频 AB 转 WAV

## 背景与原理

明日方舟音频 `.ab` 文件是 Unity AssetBundle（UnityFS v8，大端序），内部结构：

- 首个数据块用**方舟魔改 LZ4**（伪装成 LZHAM，token 高低半字节互换 + 偏移字节交换，AssetStudio/UnityPy 均解不了，报 LZHAM 错）。
- 包内两个节点：`CAB-<hash>`（AudioClip 元数据，含剪辑名）+ `CAB-<hash>.resource`（**FMOD FSB5** 音频库，内部多为 Vorbis 或 FADPCM）。

## 工具（已随技能打包在本目录）

- `tools/lzham-ab-decompressor.exe` —— 方舟 LZ4AK 解压（`--game arknights`）
- `tools/vgmstream/vgmstream-cli.exe` —— FSB5 → WAV 解码（带 libvorbis 等 DLL）
- `convert.js` —— 一键编排脚本（Node.js，Windows 自带 node 即可运行）

## 使用方式

```bash
# 单个文件（默认输出 D:\TTsongs MM）
node "C:\Users\<you>\.dsh\skills\arknights-audio\convert.js" "<xxx.ab>"

# 指定输出目录
node "...\convert.js" "<xxx.ab>" "D:\我的音乐"

# 批量转换整个文件夹（只处理顶层 *.ab）
node "...\convert.js" "D:\二游\...\audio\sound_beta_2\music\act51side"

# 融合历史分段：把输出目录里同前缀的 #1/#2 分段 WAV 合成一条歌
node "...\convert.js" --merge "D:\TTsongs MM"
```

- 默认输出目录：`D:\TTsongs MM`（不存在会自动创建）。
- 输出文件名优先取 AudioClip 真实剪辑名（如 `m_sys_act51side_loop.wav`，从 CAB 节点字符串里匹配 `<文件名>_loop`），找不到则用 AB 文件名。
- 部分音频 AB 的 `.resource` 是**多个 FSB5 库首尾拼接**，且**各库在文件中的先后不固定**（有的 [intro, loop]，有的 [loop, intro]）。每个 AB 内含两个 AudioClip：`<名>_intro`（前奏）与 `<名>_loop`（循环段），游戏先播 intro 再循环 loop。融合顺序判定：
  1. **优先读元数据**（`cabinfo.py` + Python/UnityPy）：由 `_intro` 剪辑的 `m_Resource.offset` 定位 intro 库，intro 排最前（游戏实际播放顺序，最可靠）；
  2. 元数据不可用时**退回内容检测**：开头 1 秒 RMS 最低（从静音淡入）的库排最前。
  融合输出单个 `名字_loop.wav`（不再输出 `#1`/`#2` 分段）。
- 融合要求各分段格式一致（采样率/声道/位深）；若不一致会自动退回保留 `#N` 分段并告警。
- `--merge` 模式用于把**旧版本转换出的 `#N` 分段文件**（同前缀、按数字排序）融合为单曲，成功后删除分段；已融合的单文件不受影响。

## 内部流程（排查时参考）

1. `lzham-ab-decompressor.exe --game arknights <ab> <临时>/<名>_unpacked.ab` —— 解 LZ4AK 并把整个 AB 重建为全未压缩。
2. `convert.js` 解析 UnityFS 头（大端序：signature/version/两个版本串/int64 size/块信息尺寸/flags，v7+ 对齐 16）→ 读块信息区（重建后未压缩）→ 按节点表提取 `.resource`。
3. 校验 `.resource` 魔数 `FSB5`；若文件内出现多个 `FSB5` 魔数则按位置拆分为多个库，每个库读 `0x08` 处 u32LE 得到流数。
4. 每个库写为 `<剪辑名>#<序号>.fsb`（单库则直接 `<剪辑名>.fsb`），`vgmstream-cli.exe -o <输出>.wav <fsb>` 解码（FSB5 需 `.fsb` 扩展名才能被 vgmstream 识别，脚本已处理）。

## 注意事项 / 排障

- 只支持含 `.resource`(FSB5) 节点的音频 AB；纹理/配置类 AB 会报「未找到 .resource 节点」。
- 转换结果可用 vgmstream 的 `-i` 参数查看流信息（采样率/声道/时长）。
- 若 `vgmstream-cli.exe` 报 failed opening：确认文件是 FSB5 魔数，且扩展名为 `.fsb`（脚本自动处理）。
- 输出目录含空格（如 `D:\TTsongs MM`）时脚本内部已用参数数组传路径，无需手动转义。
- 若想顺带保留中间产物（解包 AB / FSB5），可临时修改脚本或在临时目录被清理前中断——正常流程结束后临时目录自动删除。
