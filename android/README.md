# 星邮 Android

原生 Java 客户端，最低 Android 8.0，目标 Android 15。主入口 `src/io/starpost/mobile/MainActivity.java`，会话加密保存在 `SessionStore.java`，服务器协议位于 `server/mobile.mjs`。

构建：`pwsh android/build.ps1 -Sdk <AndroidSDK> -Java <JDK17>`。签名文件默认位于仓库 `.deployment/android-signing/`，务必离线备份，禁止提交。公开分发文件在 `distribution/`；GitHub Actions 检查校验值后上传签名 APK，不读取签名私钥。

界面包含人机频道、只读私聊/群聊、好友动态、广场和游戏过程。应用仅在前台刷新，不提供后台推送。没有连接实机的构建环境会完成编译、打包、签名检查，仍应在实际手机验证界面、输入法与图片选择。
