# 星邮 Android

原生 Java 客户端，最低 Android 8.0，目标 Android 15。主入口 `src/io/starpost/mobile/MainActivity.java`，会话加密保存在 `SessionStore.java`，服务器协议位于 `server/mobile.mjs`。

构建：`pwsh android/build.ps1 -Sdk <AndroidSDK> -Java <JDK17>`。签名文件默认位于仓库 `.deployment/android-signing/`，务必离线备份，禁止提交。公开分发文件在 `distribution/`；GitHub Actions 检查校验值后上传签名 APK，不读取签名私钥。

1.0.3 的会话页分为私聊和群聊。人机输入区保留稳定视图，无新消息不重建消息区，消息滚动不转移焦点。长按图片保存到应用内部收藏，按内容去重；发送表情包从分页收藏网格选择，保留原始文件，不使用文件选择器。卸载或清空数据会删除收藏。

应用仅在前台刷新，不提供后台推送。可用 JDK 执行 `tests/io/starpost/mobile/StickerLibraryTest.java` 验证收藏去重、跨实例读取、格式及路径约束。没有连接实机的构建环境会完成编译、打包、签名检查，仍应在实际手机验证界面和输入法。
