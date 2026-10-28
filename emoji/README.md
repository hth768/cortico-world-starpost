# emoji

把 PNG、JPEG、GIF 或 WebP 表情包放在这里。也可在 `worlds.starpost.emojiDir` 指向现有 QQ 扩展的 emoji 文件夹。

收到的聊天表情包默认自动收集到配置目录，按内容去重。bot 可查询、查看并填写情感、用途、标签、显示名和备注；星邮标注单独保存在实例 data/starpost-sticker-index.json，可只读导入 QQ 索引中匹配的标注。

工具参数只接受文件名；图片上限 1 MiB。动态附图同样从此文件夹读取，但不自动收集。
