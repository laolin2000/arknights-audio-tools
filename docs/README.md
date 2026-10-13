# arknights-audio —— 明日方舟音频 AssetBundle 解包（.ab → WAV）

> 一页说明：把明日方舟（含 B 服）游戏里的 `.ab` 音频文件解成可播放的 WAV。格式链路：
> **UnityFS AssetBundle → 方舟魔改 LZ4（"LZ4AK"）解压 → FMOD FSB5 容器 → WAV**。

## 用哪个？

**首选 skill**：`arknights-audio`（`~/.dsh/skills/arknights-audio/`）——它自带完整工具链
（`cabinfo.py`、`convert.js`、`tools/lzham-ab-decompressor.exe`、`tools/vgmstream/`），
对话里直接说"把这个 .ab 转成 wav"即可，不必手动敲脚本。

本目录是**工作副本与验证脚本**，用于对照/排查：

| 文件 | 作用 |
|---|---|
| `extract_ab.js` | UnityFS AssetBundle 解析器（参考 AssetStudio `BundleFile.cs`）；`node extract_ab.js <input.ab> <outdir>` |
| `cabinfo.py` | 读取 .ab 内部 CAB 信息（文件名/大小/偏移） |
| `lzham-ab-decompressor.exe` | 方舟魔改 LZ4 解压器（对应 "LZ4AK" 块） |
| `wavcheck.js` | 校验解出的 WAV 是否可播放/时长是否正确 |
| `validate_all.js` | 全量对照：每个 AB 的 intro 库（元数据）与静音淡入库（内容检测）是否一致 |
| `verify_merged.js` | 合并结果校验（用 vgmstream 交叉验证） |
| `analyze.js` | 双库音频分析：提取每个 AB 的 FSB5 库、逐个解码并计算起始能量/时长/循环标志 |

## 注意

- UnityPy / vgmstream 等第三方运行时**已不在本目录**（2026-08-26 清理历史冗余），
  脚本统一使用 skill 自带的副本；若单独运行本目录脚本，请确认对应工具路径
- 相关历史与用法细节见 `..\chat-archive\` 中的会话归档
