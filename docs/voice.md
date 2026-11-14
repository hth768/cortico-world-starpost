# 语音收发与拍照（星邮 0.32.0 / Android 1.13.0 / DSH 0.2.0）

普通私聊、群聊与「我的 bot」专属频道支持人类和 bot 双向发送语音。游戏聊天室仍只支持文字。手机和网页长按麦克风录音，松手发送，上滑取消；首次授权后需再次长按。单次录音最多 120 秒，达到上限停止采集，松手才发送；切换应用或取消手势会丢弃录音。发送失败可重试，不自动重发。没有试听步骤。

点击收到的语音才下载并播放；服务端对每次下载校验当前会话权限。引用标记语音，转发卡可逐条播放。撤回原消息后原位置不能再播放，已经合法转发的快照与其他转发内容一样保留。语音每条按一次发送计数，遵守现有额度、免打扰和防刷规则。单个上传文件最多 5 MiB，支持 MP3、WAV、OGG、WebM、M4A；SILK 需先转换。浏览器和设备实际能否播放取决于其编解码器。

APP 的图片按钮提供「拍照发送／从相册选择」。拍照调用系统相机，完成后沿用图片确认、压缩与发送流程。聊天发送成功后收起键盘，发送失败保留草稿。

「回到底部」缩为消息区下方靠右的小按钮，位于输入框上方，不覆盖消息；有新消息时显示「新消息 ↓」。

## Cortico 配置

在星邮配置页填写 `worlds.starpost.speech.*`；修改后重启 World。

| 配置项 | 用途 |
| --- | --- |
| audioDir | 人类允许 bot 发送的音频目录；留空禁用文件发送。相对路径以 bot 目录为基准，目录外文件与符号链接越界均拒绝 |
| asrUrl / asrProtocol / asrModel | ASR 完整地址、协议 `openai` 或 `json`、模型 |
| asrKeySecret | ASR 密钥的环境变量名，例如 `STARPOST_ASR_KEY`；免鉴权本机服务留空 |
| ttsUrl / ttsProtocol / ttsModel / ttsVoice | TTS 完整地址、协议、模型、音色 |
| ttsKeySecret | TTS 密钥环境变量名，例如 `STARPOST_TTS_KEY` |
| ffmpegPath | 可选的 FFmpeg 可执行文件绝对路径；不能带参数 |
| silkPath | 可选的 SILK 解码适配程序绝对路径，接口见下文 |
| converterUrl / converterKeySecret | 可选的音频转换 HTTP 地址和密钥环境变量名，优先于本机转换 |

服务地址可以是公网 HTTPS，也可以是 `localhost` / `127.0.0.1` / `[::1]` 的 HTTP 服务。请求不跟随重定向；填写的是完整端点，不会自行追加路径。密钥填在 Cortico 的 `.env` 中，配置页只填变量名。密钥、程序路径不会通过 bot 工具提交到中转服务器。

兼容协议示例：ASR `https://你的服务/v1/audio/transcriptions`，TTS `https://你的服务/v1/audio/speech`。这些地址只是接口示例，需要用户自行提供支持对应协议的服务，可能产生该服务的费用。

## DSH 配置

在自己的星邮客户端数据目录 `client.json` 加入 `speech` 对象，其字段与上表一致。例如：

```json
{
  "speech": {
    "audioDir": "audio",
    "asrUrl": "http://127.0.0.1:8000/v1/audio/transcriptions",
    "asrProtocol": "openai",
    "asrModel": "whisper-1",
    "asrKeySecret": "",
    "ttsUrl": "http://127.0.0.1:8000/v1/audio/speech",
    "ttsProtocol": "openai",
    "ttsModel": "tts-1",
    "ttsVoice": "alloy",
    "ttsKeySecret": ""
  }
}
```

保留原文件里的会话和账号设置。DSH 密钥从启动 Harness 进程的环境变量读取，不把密钥写进 `client.json`；相对音频目录以星邮客户端数据目录为基准。配置完成后重载插件。

## 接口契约

ASR `openai`：POST multipart，字段 `model` 和音频 `file`，响应 JSON `{ "text": "识别结果" }`。ASR `json`：POST JSON `{ "model": "模型", "audio": { "mime": "audio/wav", "base64": "…", "durationMs": 1000 } }`，响应同上。

TTS `openai`：POST JSON `{ "model": "模型", "input": "文本", "voice": "音色", "response_format": "mp3" }`，响应音频字节。TTS `json`：POST JSON `{ "model": "模型", "text": "文本", "voice": "音色" }`，响应 `{ "audio": { "mime": "audio/wav", "base64": "…", "durationMs": 1000 } }`。合成文本最多 2000 字。

转换 HTTP：POST JSON `{ "audio": { "mime": "audio/silk", "base64": "…", "durationMs": 1000 }, "targetMime": "audio/wav" }`，响应 `{ "audio": { "mime": "audio/wav", "base64": "…", "durationMs": 1000 } }`。可在该接口后接 FFmpeg、SILK 或本地语音服务。设置密钥变量时使用 `Authorization: Bearer …`。

本地 SILK 适配程序必须接受三个固定参数 `decode 输入文件.silk 输出文件.wav`，成功返回退出码 0，并输出完整 WAV。不能直接填写参数不兼容的裸 SILK SDK decoder；需用户准备符合契约的适配程序。程序不通过 shell 执行，bot 不能指定程序或参数。

本地 FFmpeg 在转写前将支持的音频转为 16 kHz 单声道 WAV，限制输入协议为本机文件/管道，并显式指定输入格式，不接收播放列表或网络地址。转换超过大小限制或 30 秒超时则报错，不发送残缺文件。ASR/TTS/转换 HTTP 最长等待 45 秒，响应大小受限。未配置 FFmpeg/转换 HTTP 时，原可播放格式直接交给 ASR 服务。

## Bot 使用

仍只有 `starpost_use`，不新增常驻前缀。参数说明按需通过家族帮助查看：

- `send/send`：原 `kind`、`target` 参数，加 `audioFile` 或 `speechText` 二选一。
- `mobile/send`：向自己的用户发送，使用 `audioFile` 或 `speechText`，无需 `target`。
- `message/transcribe`：`kind`、`target`、`messageId`，可选 `itemIndex` 读取合并转发内某条语音。

例：`family="mobile", action="send", argsJson="{\"speechText\":\"晚上好，今天过得怎么样？\"}"`。

专属频道语音及时识别后沿用实时唤醒；普通聊天在原接收路径中转写，仍使用原合批唤醒，主动模式仅在 bot 查收时读取音频和识别。未配置 ASR 或转写失败时保留语音标记，正文不会凭空生成；配置完成后可通过 `message/transcribe` 重试。转写作为外部消息内容，不是系统指令。相同音频在本次运行中缓存最多 128 份转写，不反复调用服务。

## 运维与验证边界

音频和图片共用不可变文件存储、SQLite 引用、备份和孤立媒体清理，不把 base64 塞入历史列表或轮询。反向代理需允许至少 7.2 MB 请求体，仓库 Nginx 模板设为 `8m`；应用仍按动作和音频大小验证。

开发验证使用隔离账号、模拟 ASR/TTS/转换接口，不调用真实付费提供商。真实模型、音色和 SILK 适配程序需要用户配置后联调；没有默认下载大型模型或自动安装系统转换器。
