"use strict";

window.CONFIG_SCHEMA = {
  siteGroups: [
    {
      id: "site-basic",
      title: "基础信息",
      description: "站点名称、作者、语言和搜索摘要信息。",
      fields: [
        { path: "title", label: "站点标题", type: "text", placeholder: "例如：我的博客", span: 2 },
        { path: "subtitle", label: "副标题", type: "text", placeholder: "记录所见所思所感", span: 2 },
        { path: "description", label: "站点描述", type: "textarea", placeholder: "用于搜索引擎和社交分享的站点描述。", span: 2 },
        { path: "keywords", label: "关键词", type: "list", hint: "每行一个关键词。", span: 2 },
        { path: "author", label: "作者", type: "text", placeholder: "你的名字" },
        { path: "language", label: "语言", type: "select", allowCustom: true, options: [
          { value: "zh-CN", label: "简体中文 · zh-CN" }, { value: "zh-TW", label: "繁体中文 · zh-TW" },
          { value: "en", label: "English · en" }, { value: "ja", label: "日本語 · ja" }, { value: "ko", label: "한국어 · ko" }
        ] },
        { path: "timezone", label: "时区", type: "text", placeholder: "Asia/Shanghai", listId: "timezoneOptions" }
      ]
    },
    {
      id: "site-url",
      title: "网址与链接",
      description: "站点地址、文章永久链接和尾斜杠策略。",
      fields: [
        { path: "url", label: "站点 URL", type: "text", placeholder: "https://example.com/", span: 2 },
        { path: "permalink", label: "永久链接格式", type: "text", placeholder: ":year/:month/:hash.html", span: 2, mono: true },
        { path: "pretty_urls.trailing_index", label: "保留 index.html", type: "boolean" },
        { path: "pretty_urls.trailing_html", label: "保留 .html", type: "boolean" }
      ]
    },
    {
      id: "site-writing",
      title: "写作与生成",
      description: "新文章命名、草稿、资源目录和构建行为。",
      fields: [
        { path: "new_post_name", label: "新文章文件名", type: "text", mono: true },
        { path: "default_layout", label: "默认布局", type: "text", mono: true },
        { path: "filename_case", label: "文件名大小写", type: "select", options: [
          { value: 0, label: "保持原样" }, { value: 1, label: "转换为小写" }, { value: 2, label: "转换为大写" }
        ] },
        { path: "render_drafts", label: "渲染草稿", type: "boolean" },
        { path: "post_asset_folder", label: "文章资源目录", type: "boolean" },
        { path: "relative_link", label: "使用相对链接", type: "boolean" },
        { path: "future", label: "发布未来文章", type: "boolean" },
        { path: "titlecase", label: "标题自动首字母大写", type: "boolean" }
      ]
    }
    ,
    {
      id: "site-highlight",
      title: "代码高亮",
      description: "Hexo 渲染阶段的高亮器与行号设置。",
      fields: [
        { path: "syntax_highlighter", label: "高亮器", type: "select", options: [
          { value: "highlight.js", label: "highlight.js" }, { value: "prismjs", label: "prismjs" }, { value: "", label: "关闭" }
        ] },
        { path: "highlight.line_number", label: "highlight 行号", type: "boolean" },
        { path: "highlight.auto_detect", label: "自动识别语言", type: "boolean" },
        { path: "highlight.wrap", label: "自动换行", type: "boolean" },
        { path: "highlight.hljs", label: "使用 hljs 类名", type: "boolean" },
        { path: "highlight.tab_replace", label: "Tab 替换字符", type: "text", mono: true },
        { path: "prismjs.preprocess", label: "Prism 预处理", type: "boolean" },
        { path: "prismjs.line_number", label: "Prism 行号", type: "boolean" },
        { path: "prismjs.tab_replace", label: "Prism Tab 替换", type: "text", mono: true }
      ]
    },
    {
      id: "site-index",
      title: "首页与分页",
      description: "首页生成器、分页数量和日期格式。",
      fields: [
        { path: "index_generator.path", label: "首页路径", type: "text" },
        { path: "index_generator.per_page", label: "首页文章数量", type: "number", min: 0 },
        { path: "index_generator.order_by", label: "首页排序", type: "text", mono: true },
        { path: "per_page", label: "归档每页数量", type: "number", min: 0 },
        { path: "pagination_dir", label: "分页目录", type: "text", mono: true },
        { path: "date_format", label: "日期格式", type: "text", mono: true },
        { path: "time_format", label: "时间格式", type: "text", mono: true },
        { path: "updated_option", label: "更新时间来源", type: "select", options: [
          { value: "mtime", label: "文件修改时间" }, { value: "date", label: "文章 date" }, { value: "empty", label: "不显示" }
        ] }
      ]
    },
    {
      id: "site-deploy",
      title: "主题与部署",
      description: "启用主题、Git 部署目标和自动分类插件。",
      fields: [
        { path: "theme", label: "主题名称", type: "text", mono: true },
        { path: "deploy.type", label: "部署类型", type: "select", options: [
          { value: "git", label: "Git" }, { value: "rsync", label: "rsync" }, { value: "ftp", label: "FTP" }
        ] },
        { path: "deploy.repo", label: "仓库地址", type: "text", span: 2, mono: true },
        { path: "deploy.branch", label: "部署分支", type: "text", mono: true },
        { path: "auto_category.enable", label: "自动分类", type: "boolean" },
        { path: "auto_category.depth", label: "分类深度", type: "number", min: 1 }
      ]
    }
  ],
  themeGroups: [
    {
      id: "theme-nav",
      title: "导航栏",
      description: "顶部导航 Logo、标题和固定行为。",
      fields: [
        { path: "nav.logo", imagePicker: true, label: "导航 Logo", type: "text", span: 2 },
        { path: "nav.display_title", label: "显示站点标题", type: "boolean" },
        { path: "nav.display_post_title", label: "文章页显示标题", type: "boolean" },
        { path: "nav.fixed", label: "固定导航栏", type: "boolean" }
      ]
    },
    {
      id: "theme-images",
      title: "图片与横幅",
      description: "头像、favicon 和各页面默认图片。",
      fields: [
        { path: "favicon", imagePicker: true, label: "Favicon", type: "text", mono: true },
        { path: "avatar.img", imagePicker: true, label: "头像图片", type: "text", mono: true },
        { path: "avatar.effect", label: "头像动效", type: "text", mono: true },
        { path: "disable_top_img", label: "禁用顶部图片", type: "boolean" },
        { path: "default_top_img", imagePicker: true, label: "默认顶部图片", type: "text", span: 2, mono: true },
        { path: "index_img", imagePicker: true, label: "首页图片", type: "text", span: 2, mono: true },
        { path: "archive_img", imagePicker: true, label: "归档页图片", type: "text", span: 2, mono: true },
        { path: "tag_img", imagePicker: true, label: "标签页图片", type: "text", span: 2, mono: true },
        { path: "category_img", imagePicker: true, label: "分类页图片", type: "text", span: 2, mono: true },
        { path: "footer_img", imagePicker: true, label: "页脚图片", type: "text", mono: true },
        { path: "background", imagePicker: true, label: "网页背景", type: "text", span: 2, mono: true },
        { path: "cover.index_enable", label: "首页封面", type: "boolean" },
        { path: "cover.aside_enable", label: "侧栏封面", type: "boolean" },
        { path: "cover.archives_enable", label: "归档封面", type: "boolean" }
      ]
    },
    {
      id: "theme-home",
      title: "首页与摘要",
      description: "首页布局、副标题打字机效果和摘要策略。",
      fields: [
        { path: "index_layout", label: "首页布局", type: "select", options: [
          { value: 1, label: "1 · 左图右文" }, { value: 2, label: "2 · 右图左文" }, { value: 3, label: "3 · 左右交替" },
          { value: 4, label: "4 · 上图下文" }, { value: 5, label: "5 · 信息覆盖封面" }, { value: 6, label: "6 · 瀑布流" }, { value: 7, label: "7 · 瀑布流覆盖" }
        ] },
        { path: "index_site_info_top", label: "站点信息位置", type: "text", mono: true },
        { path: "index_top_img_height", label: "顶部图片高度", type: "text", mono: true },
        { path: "subtitle.enable", label: "启用副标题", type: "boolean" },
        { path: "subtitle.effect", label: "打字机效果", type: "boolean" },
        { path: "subtitle.source", label: "一言来源", type: "select", options: [
          { value: false, label: "关闭" }, { value: 1, label: "hitokoto.cn" }, { value: 2, label: "api.aa1.cn" }, { value: 3, label: "jinrishici.com" }
        ] },
        { path: "subtitle.sub", label: "副标题内容", type: "list", span: 2, hint: "每行一句。" },
        { path: "index_post_content.method", label: "摘要方式", type: "select", options: [
          { value: 1, label: "description" }, { value: 2, label: "自动摘要优先" }, { value: 3, label: "auto_excerpt" }, { value: 4, label: "截断正文" }
        ] },
        { path: "index_post_content.length", label: "摘要长度", type: "number", min: 0 }
      ]
    },
    {
      id: "theme-code",
      title: "Butterfly 代码块",
      description: "主题代码块外观、工具栏和折叠行为。",
      fields: [
        { path: "code_blocks.theme", label: "代码主题", type: "select", options: [
          { value: "darker", label: "darker" }, { value: "pale night", label: "pale night" },
          { value: "light", label: "light" }, { value: "ocean", label: "ocean" }, { value: false, label: "关闭" }
        ] },
        { path: "code_blocks.macStyle", label: "Mac 风格", type: "boolean" },
        { path: "code_blocks.height_limit", label: "高度限制（px）", type: "text", mono: true, placeholder: "false 或 300" },
        { path: "code_blocks.word_wrap", label: "代码自动换行", type: "boolean" },
        { path: "code_blocks.copy", label: "复制按钮", type: "boolean" },
        { path: "code_blocks.language", label: "语言标签", type: "boolean" },
        { path: "code_blocks.shrink", label: "折叠按钮", type: "select", options: [
          { value: false, label: "展开" }, { value: true, label: "收起" }, { value: "none", label: "隐藏按钮" }
        ] },
        { path: "code_blocks.fullpage", label: "全屏按钮", type: "boolean" }
      ]
    }
    ,
    {
      id: "theme-article",
      title: "文章页",
      description: "目录、版权、打赏、相关文章和过期提醒。",
      fields: [
        { path: "toc.post", label: "文章显示目录", type: "boolean" },
        { path: "toc.page", label: "页面显示目录", type: "boolean" },
        { path: "toc.number", label: "目录显示序号", type: "boolean" },
        { path: "toc.expand", label: "目录默认展开", type: "boolean" },
        { path: "toc.style_simple", label: "简化目录样式", type: "boolean" },
        { path: "toc.scroll_percent", label: "显示阅读进度", type: "boolean" },
        { path: "post_copyright.enable", label: "文章版权卡片", type: "boolean" },
        { path: "post_copyright.decode", label: "链接解密", type: "boolean" },
        { path: "post_copyright.author_href", label: "作者链接", type: "text", span: 2 },
        { path: "post_copyright.license", label: "许可证名称", type: "text" },
        { path: "post_copyright.license_url", label: "许可证 URL", type: "text", mono: true },
        { path: "reward.enable", label: "启用打赏", type: "boolean" },
        { path: "reward.text", label: "打赏按钮文字", type: "text" },
        { path: "post_edit.enable", label: "文章编辑按钮", type: "boolean" },
        { path: "post_edit.url", label: "编辑地址模板", type: "text", span: 2, mono: true },
        { path: "related_post.enable", label: "相关文章", type: "boolean" },
        { path: "related_post.limit", label: "相关文章数量", type: "number", min: 0 },
        { path: "related_post.date_type", label: "相关文章日期", type: "select", options: [
          { value: "created", label: "创建时间" }, { value: "updated", label: "更新时间" }
        ] },
        { path: "post_pagination", label: "上下篇导航", type: "select", options: [
          { value: 1, label: "简单模式" }, { value: 2, label: "显示标题模式" }, { value: false, label: "关闭" }
        ] },
        { path: "noticeOutdate.enable", label: "文章过期提醒", type: "boolean" },
        { path: "noticeOutdate.limit_day", label: "过期天数", type: "number", min: 1 },
        { path: "noticeOutdate.position", label: "提醒位置", type: "select", options: [
          { value: "top", label: "文章顶部" }, { value: "bottom", label: "文章底部" }
        ] }
      ]
    },
    {
      id: "theme-sidebar",
      title: "侧边栏与页脚",
      description: "侧边栏卡片、作者信息、公告与页脚版权。",
      fields: [
        { path: "aside.enable", label: "启用侧边栏", type: "boolean" },
        { path: "aside.hide", label: "默认隐藏侧边栏", type: "boolean" },
        { path: "aside.button", label: "显示切换按钮", type: "boolean" },
        { path: "aside.mobile", label: "移动端显示侧栏", type: "boolean" },
        { path: "aside.position", label: "侧栏位置", type: "select", options: [
          { value: "left", label: "左侧" }, { value: "right", label: "右侧" }
        ] },
        { path: "aside.card_author.enable", label: "作者卡片", type: "boolean" },
        { path: "aside.card_author.description", label: "作者描述", type: "textarea", span: 2 },
        { path: "aside.card_author.button.enable", label: "作者卡片按钮", type: "boolean" },
        { path: "aside.card_author.button.icon", label: "按钮图标", type: "text", mono: true },
        { path: "aside.card_author.button.text", label: "按钮文字", type: "text" },
        { path: "aside.card_author.button.link", label: "按钮链接", type: "text", span: 2 },
        { path: "aside.card_announcement.enable", label: "公告卡片", type: "boolean" },
        { path: "aside.card_announcement.content", label: "公告内容", type: "textarea", span: 2 },
        { path: "aside.card_recent_post.enable", label: "最新文章卡片", type: "boolean" },
        { path: "aside.card_recent_post.limit", label: "最新文章数量", type: "number", min: 1 },
        { path: "aside.card_categories.enable", label: "分类卡片", type: "boolean" },
        { path: "aside.card_categories.limit", label: "分类显示数量", type: "number", min: 1 },
        { path: "aside.card_tags.enable", label: "标签卡片", type: "boolean" },
        { path: "aside.card_tags.limit", label: "标签显示数量", type: "number", min: 1 },
        { path: "aside.card_archives.enable", label: "归档卡片", type: "boolean" },
        { path: "aside.card_archives.limit", label: "归档显示数量", type: "number", min: 1 },
        { path: "aside.card_webinfo.enable", label: "站点信息卡片", type: "boolean" },
        { path: "footer.owner.enable", label: "页脚作者信息", type: "boolean" },
        { path: "footer.owner.since", label: "建站年份", type: "number", min: 2000 },
        { path: "footer.copyright.enable", label: "页脚版权", type: "boolean" },
        { path: "footer.copyright.version", label: "显示主题版本", type: "boolean" },
        { path: "footer.custom_text", label: "页脚自定义文字", type: "textarea", span: 2 }
      ]
    }
    ,
    {
      id: "theme-appearance",
      title: "外观与交互",
      description: "深浅色模式、字体、圆角、阅读模式和顶部图标。",
      fields: [
        { path: "darkmode.enable", label: "启用深色模式", type: "boolean" },
        { path: "darkmode.button", label: "显示主题切换按钮", type: "boolean" },
        { path: "darkmode.autoChangeMode", label: "自动切换深色模式", type: "select", options: [
          { value: false, label: "关闭" }, { value: "system", label: "跟随系统" }, { value: "time", label: "按时间自动切换" }, { value: true, label: "启用自动切换" }
        ] },
        { path: "display_mode", label: "默认显示模式", type: "select", options: [
          { value: "light", label: "浅色" }, { value: "dark", label: "深色" }
        ] },
        { path: "readmode", label: "阅读模式", type: "boolean" },
        { path: "rounded_corners_ui", label: "圆角 UI", type: "boolean" },
        { path: "text_align_justify", label: "正文两端对齐", type: "boolean" },
        { path: "enter_transitions", label: "进入页面动画", type: "boolean" },
        { path: "font.global_font_size", label: "全局字号", type: "text", placeholder: "16px" },
        { path: "font.code_font_size", label: "代码字号", type: "text", placeholder: "14px" },
        { path: "font.font_family", label: "正文字体", type: "text", span: 2 },
        { path: "font.code_font_family", label: "代码字体", type: "text", span: 2 },
        { path: "blog_title_font.font_link", label: "标题字体链接", type: "text", span: 2 },
        { path: "blog_title_font.font_family", label: "标题字体名称", type: "text", span: 2 },
        { path: "hr_icon.enable", label: "文章分隔图标", type: "boolean" },
        { path: "hr_icon.icon", label: "分隔图标", type: "text", mono: true },
        { path: "mask.header", label: "顶部图片遮罩", type: "boolean" },
        { path: "mask.footer", label: "页脚图片遮罩", type: "boolean" }
      ]
    },
    {
      id: "theme-features",
      title: "搜索、分享与评论",
      description: "常用第三方功能和社交组件的总开关。",
      fields: [
        { path: "search.use", label: "搜索方式", type: "select", options: [
          { value: false, label: "关闭" }, { value: "local_search", label: "本地搜索" },
          { value: "algolia_search", label: "Algolia" }, { value: "docsearch", label: "DocSearch" }
        ] },
        { path: "search.placeholder", label: "搜索框提示", type: "text" },
        { path: "search.local_search.preload", label: "本地搜索预加载", type: "boolean" },
        { path: "search.local_search.top_n_per_article", label: "每篇最多匹配", type: "number", min: 1 },
        { path: "search.local_search.unescape", label: "反转义 HTML", type: "boolean" },
        { path: "share.use", label: "分享组件", type: "select", options: [
          { value: false, label: "关闭" }, { value: "sharejs", label: "share.js" }, { value: "addtoany", label: "AddToAny" }
        ] },
        { path: "share.sharejs.sites", label: "Share.js 站点", type: "text", span: 2, mono: true },
        { path: "share.addtoany.item", label: "AddToAny 项目", type: "text", span: 2, mono: true },
        { path: "comments.use", label: "评论系统", type: "select", options: [
          { value: false, label: "关闭" }, { value: "disqus", label: "Disqus" }, { value: "giscus", label: "Giscus" },
          { value: "twikoo", label: "Twikoo" }, { value: "waline", label: "Waline" }, { value: "valine", label: "Valine" },
          { value: "gitalk", label: "Gitalk" }, { value: "artalk", label: "Artalk" }
        ] },
        { path: "comments.text", label: "评论标题", type: "boolean" },
        { path: "comments.lazyload", label: "评论懒加载", type: "boolean" },
        { path: "comments.count", label: "评论计数", type: "boolean" },
        { path: "comments.card_post_count", label: "侧栏评论数", type: "boolean" }
      ]
    },
    {
      id: "theme-advanced-features",
      title: "增强功能",
      description: "图标、PWA、SEO、Snackbar、Mermaid 和渐进式加载。",
      fields: [
        { path: "pwa.enable", label: "启用 PWA", type: "boolean" },
        { path: "Open_Graph_meta.enable", label: "Open Graph 元数据", type: "boolean" },
        { path: "structured_data.enable", label: "结构化数据", type: "boolean" },
        { path: "css_prefix", label: "CSS 厂商前缀", type: "boolean" },
        { path: "instantpage", label: "Instant.page", type: "boolean" },
        { path: "lazyload.enable", label: "图片懒加载", type: "boolean" },
        { path: "lazyload.native", label: "使用浏览器原生懒加载", type: "boolean" },
        { path: "lazyload.field", label: "懒加载范围", type: "select", options: [
          { value: "site", label: "全站" }, { value: "post", label: "仅文章" }
        ] },
        { path: "snackbar.enable", label: "Snackbar 通知", type: "boolean" },
        { path: "snackbar.position", label: "通知位置", type: "select", options: [
          { value: "top-left", label: "左上" }, { value: "top-center", label: "顶部居中" }, { value: "top-right", label: "右上" },
          { value: "bottom-left", label: "左下" }, { value: "bottom-center", label: "底部居中" }, { value: "bottom-right", label: "右下" }
        ] },
        { path: "mermaid.enable", label: "Mermaid 图表", type: "boolean" },
        { path: "mermaid.theme.light", label: "Mermaid 浅色主题", type: "text" },
        { path: "mermaid.theme.dark", label: "Mermaid 深色主题", type: "text" },
        { path: "note.style", label: "Note 样式", type: "select", options: [
          { value: "simple", label: "simple" }, { value: "modern", label: "modern" }, { value: "flat", label: "flat" }, { value: "disabled", label: "disabled" }
        ] },
        { path: "note.icons", label: "Note 图标", type: "boolean" },
        { path: "note.border_radius", label: "Note 圆角", type: "number", min: 0 },
        { path: "preloader.enable", label: "加载动画", type: "boolean" },
        { path: "preloader.source", label: "加载动画来源", type: "number", min: 1, max: 4 }
      ]
    }
  ]
};





