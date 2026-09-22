"use strict";

(function () {
  const fallbackDescription = "暂无官方说明，建议参考主题文档";
  const options = (...pairs) => pairs.map(([value, label]) => ({ value, label }));
  const makeField = (definition) => {
    const [label, description, choices, type] = definition;
    return {
      label,
      description: description || fallbackDescription,
      options: choices || [],
      type,
    };
  };
  const group = (title, description, fields, order = 999) => ({
    title,
    description,
    order,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, definition]) => [key, makeField(definition)])
    ),
  });

  const site = {
    source_dir: group("源文件目录", "Hexo 内容源目录。", {
      ".": ["源文件目录", "保存文章、页面和图片等源文件的目录，通常保持为 source。"],
    }, 650),
    public_dir: group("生成目录", "Hexo 静态输出目录。", {
      ".": ["静态文件输出目录", "hexo generate 生成的 HTML 和资源目录，通常保持为 public。"],
    }, 651),
    archive_dir: group("归档路径", "归档页面的 URL 路径。", {
      ".": ["归档目录", "归档页面的访问目录，默认生成 /archives/。"],
    }, 652),
    category_dir: group("分类路径", "分类页面的 URL 路径。", {
      ".": ["分类目录", "分类列表和分类详情页使用的访问目录。"],
    }, 653),
    tag_dir: group("标签路径", "标签页面的 URL 路径。", {
      ".": ["标签目录", "标签列表和标签详情页使用的访问目录。"],
    }, 654),
    code_dir: group("代码下载路径", "文章内代码文件下载链接的存放目录。", {
      ".": ["代码下载目录", "代码下载资源在站点中的相对路径，默认是 downloads/code。"],
    }, 655),
    i18n_dir: group("多语言路径", "多语言页面使用的目录规则。", {
      ".": ["多语言目录", "语言代码在 URL 中的位置，例如 :lang 表示使用当前语言作为一级路径。"],
    }, 656),
    default_category: group("分类默认值", "文章没有指定分类时使用的默认分类。", {
      ".": ["默认分类", "文章 front-matter 未填写 categories 时自动归入的分类名称。"],
    }, 657),
    category_map: group("分类映射", "将分类名称映射到自定义 URL 路径。", {
      ".": ["分类路径映射", "用 分类名: 路径名 的形式改变分类页面的实际 URL。"],
    }, 658),
    tag_map: group("标签映射", "将标签名称映射到自定义 URL 路径。", {
      ".": ["标签路径映射", "用 标签名: 路径名 的形式改变标签页面的实际 URL。"],
    }, 659),
    permalink_defaults: group("永久链接变量", "为 permalink 中使用的自定义变量提供默认值。", {
      ".": ["永久链接默认变量", "定义 permalink 模板中额外变量对应的默认值。"],
    }, 660),
    external_link: group("外部链接", "控制正文中的外部链接如何打开。", {
      enable: ["新窗口打开", "启用后，文章中的外部链接会在新标签页打开。"],
      field: ["作用范围", "选择外部链接处理规则应用于整站还是仅文章页。", options(["site", "全站"], ["post", "仅文章"])],
      exclude: ["排除域名", "这些域名不会被当作需要特殊处理的外部链接。"],
    }, 661),
    include: group("包含文件", "只包含匹配规则的文件进行渲染。", {
      ".": ["包含规则", "使用 glob 规则指定需要包含的源文件。"],
    }, 662),
    exclude: group("排除文件", "排除指定源文件，不参与渲染。", {
      ".": ["排除规则", "使用 glob 规则指定不参与生成的源文件。"],
    }, 663),
    ignore: group("忽略路径", "让 Hexo 在扫描时忽略指定文件或目录。", {
      ".": ["忽略规则", "使用 glob 规则排除不需要扫描的路径。"],
    }, 664),
    skip_render: group("跳过渲染", "复制指定源文件，但不进行模板渲染。", {
      ".": ["跳过渲染的文件", "列出的文件会原样复制到 public，适合 HTML 示例或第三方页面。"],
    }, 665),
    meta_generator: group("生成器元信息", "控制页面中是否写入 Hexo 生成器标识。", {
      ".": ["输出 Hexo 元信息", "启用后页面 head 中会加入 generator 元标签。"],
    }, 666),
  };

  const theme = {
    CDN: group("CDN 分发", "控制主题内部脚本和第三方脚本的加载来源。", {
      internal_provider: ["内部脚本来源", "主题自身 JS/CSS 的来源，常用 local、jsdelivr、unpkg、cdnjs。", options(["local", "本地文件"], ["jsdelivr", "jsDelivr"], ["unpkg", "unpkg"], ["cdnjs", "cdnjs"], ["custom", "自定义"])],
      third_party_provider: ["第三方脚本来源", "评论、搜索、统计等第三方资源的 CDN 来源。", options(["local", "本地文件"], ["jsdelivr", "jsDelivr"], ["unpkg", "unpkg"], ["cdnjs", "cdnjs"], ["custom", "自定义"])],
      version: ["附加版本号", "启用后在 CDN 地址中加入资源版本，避免浏览器缓存旧文件。"],
      custom_format: ["自定义 CDN 模板", "选择 custom 来源时使用的 URL 模板。"],
      option: ["其他 CDN 参数", "传给 CDN 加载器的补充参数。"],
    }, 300),
    Open_Graph_meta: group("Open Graph 社交分享", "控制分享卡片使用的社交平台元数据。", {
      option: ["社交平台选项", "配置 Twitter、Facebook 等分享卡片使用的补充字段。"],
    }, 302),
    abcjs: group("ABC 乐谱", "在文章中渲染 ABC 记谱法乐谱。", {
      enable: ["启用 ABC 乐谱", "启用后支持使用 abcjs 代码块显示乐谱。"],
      per_page: ["按页面加载资源", "仅在包含乐谱的页面加载 abcjs 资源，减少普通页面开销。"],
    }, 304),
    activate_power_mode: group("打字特效", "输入时触发彩色粒子和屏幕震动效果。", {
      enable: ["启用打字特效", "开启输入时页面粒子动画效果。"],
      colorful: ["彩色粒子", "粒子使用随机颜色；关闭后使用单色。"],
      shake: ["屏幕震动", "快速输入时让编辑区域产生轻微震动。"],
      mobile: ["移动端启用", "允许在手机和平板上显示该特效。"],
    }, 306),
    ad: group("广告", "控制首页、侧边栏和文章页中的广告内容。", {
      index: ["首页广告", "插入首页文章列表中的广告 HTML。"],
      aside: ["侧边栏广告", "显示在侧边栏指定位置的广告内容。"],
      post: ["文章页广告", "插入文章正文区域的广告 HTML。"],
    }, 308),
    anchor: group("标题锚点", "控制标题锚点的滚动和 URL 更新行为。", {
      auto_update: ["自动更新 URL", "滚动页面时根据当前标题自动更新地址栏锚点。"],
      click_to_scroll: ["点击标题滚动", "点击标题锚点时平滑滚动到对应位置。"],
    }, 310),
    artalk: group("Artalk 评论", "连接 Artalk 自托管评论服务。", {
      server: ["服务器地址", "Artalk 后端服务的完整地址。"],
      site: ["站点名称", "在 Artalk 后台用于区分当前博客的站点标识。"],
      visitor: ["访客标识", "控制 Artalk 使用的访客记录方式。"],
      option: ["其他 Artalk 参数", "传给 Artalk 初始化方法的补充配置。"],
    }, 312),
    aside: group("侧边栏补充设置", "控制侧边栏卡片、排序、显示范围和归档展示。", {
      "display.archive": ["显示归档卡片", "是否在侧边栏显示归档入口。"],
      "display.tag": ["显示标签卡片", "是否在侧边栏显示标签入口。"],
      "display.category": ["显示分类卡片", "是否在侧边栏显示分类入口。"],
      "card_recent_post.sort": ["最近文章排序依据", "按文章日期或更新时间对最近文章排序。"],
      "card_recent_post.sort_order": ["最近文章排序方向", "1 为升序，-1 为降序。"],
      "card_newest_comments.enable": ["显示最新评论", "是否在侧边栏显示最新评论卡片。"],
      "card_newest_comments.sort_order": ["最新评论排序方向", "控制评论卡片的排序方向。"],
      "card_newest_comments.limit": ["最新评论数量", "最多显示的评论条数。"],
      "card_newest_comments.storage": ["评论缓存时长", "评论数据在本地缓存的有效时间。"],
      "card_newest_comments.avatar": ["显示评论头像", "是否在最新评论中显示访客头像。"],
      "card_categories.expand": ["分类展开方式", "none 表示收起，true 展开全部，false 使用默认折叠状态。"],
      "card_categories.sort_order": ["分类排序方向", "控制分类卡片的排序方向。"],
      "card_tags.color": ["标签彩色背景", "是否给标签卡片中的标签使用不同颜色。"],
      "card_tags.custom_colors": ["标签自定义颜色", "为指定标签设置自定义颜色列表。"],
      "card_tags.orderby": ["标签排序依据", "按随机、名称或文章数量排序标签。", options(["random", "随机"], ["name", "名称"], ["length", "数量"])],
      "card_tags.order": ["标签排序方向", "1 为升序，-1 为降序。"],
      "card_tags.sort_order": ["标签排序覆盖", "可选的标签排序覆盖设置。"],
      "card_archives.type": ["归档统计周期", "按月或按年统计文章。", options(["monthly", "按月"], ["yearly", "按年"])],
      "card_archives.format": ["归档日期格式", "使用 Moment.js 格式显示归档时间。"],
      "card_archives.order": ["归档排序方向", "1 为升序，-1 为降序。"],
      "card_archives.sort_order": ["归档排序覆盖", "可选的归档排序覆盖设置。"],
      "card_post_series.enable": ["显示文章系列", "是否在侧边栏显示当前文章所属系列。"],
      "card_post_series.series_title": ["系列标题", "文章系列卡片的标题文字。"],
      "card_post_series.orderBy": ["系列排序依据", "按标题或日期排列系列文章。", options(["title", "标题"], ["date", "日期"])],
      "card_post_series.order": ["系列排序方向", "1 为升序，-1 为降序。"],
      "card_webinfo.post_count": ["显示文章总数", "是否在网站信息卡片显示文章数量。"],
      "card_webinfo.last_push_date": ["显示最近更新", "是否显示博客最近更新日期。"],
      "card_webinfo.sort_order": ["网站信息排序", "控制网站信息卡片的排序。"],
      "card_webinfo.runtime_date": ["显示运行时间", "是否显示博客自指定日期以来的运行时长。"],
    }, 314),
    baidu_analytics: group("百度统计", "接入百度统计站点代码。", {
      ".": ["百度统计 ID", "填写百度统计后台提供的站点标识。"],
    }, 316),
    beautify: group("标题美化", "为文章标题添加图标和前缀装饰。", {
      enable: ["启用标题美化", "开启文章标题前缀图标和颜色效果。"],
      field: ["作用范围", "选择仅文章页或全站页面应用标题美化。", options(["post", "仅文章页"], ["site", "全站"])],
      title_prefix_icon: ["标题前缀图标", "填写 Font Awesome 图标类名。"],
      title_prefix_icon_color: ["图标颜色", "设置标题前缀图标的颜色。"],
    }, 318),
    busuanzi: group("不蒜子统计", "显示站点访问量和页面访问量统计。", {
      site_uv: ["站点访客数", "显示网站独立访客数量。"],
      site_pv: ["站点访问量", "显示网站总访问次数。"],
      page_pv: ["页面访问量", "显示当前页面的访问次数。"],
    }, 320),
    canvas_fluttering_ribbon: group("飘动缎带", "在页面背景显示飘动彩带动画。", {
      enable: ["启用飘动缎带", "开启背景飘带效果。"],
      mobile: ["移动端启用", "允许在移动设备显示该效果。"],
    }, 322),
    canvas_nest: group("粒子连线", "在页面背景显示动态粒子连线。", {
      enable: ["启用粒子连线", "开启背景粒子网络效果。"],
      color: ["粒子颜色", "使用 RGB 数值设置粒子颜色。"],
      opacity: ["粒子透明度", "设置粒子效果的透明程度。"],
      zIndex: ["背景层级", "控制画布在页面中的层叠位置。"],
      count: ["粒子数量", "背景中的粒子总数。"],
      mobile: ["移动端启用", "允许在移动设备显示粒子效果。"],
    }, 324),
    canvas_ribbon: group("彩带背景", "显示可点击交互的彩色飘带。", {
      enable: ["启用彩带背景", "开启彩色飘带动画。"],
      size: ["彩带大小", "控制飘带线条的粗细或尺寸。"],
      alpha: ["彩带透明度", "设置飘带的透明程度。"],
      zIndex: ["背景层级", "控制彩带画布的层叠位置。"],
      click_to_change: ["点击切换颜色", "点击页面时随机切换彩带颜色。"],
      mobile: ["移动端启用", "允许在移动设备显示彩带。"],
    }, 326),
    category_per_img: group("分类页顶部图", "为不同分类配置各自的顶部图片。", {
      ".": ["分类图片映射", "按分类名称设置对应的顶部图片路径。"],
    }, 328),
    category_ui: group("分类页 UI", "自定义分类页面的布局与显示元素。", {
      ".": ["分类页界面选项", "分类页面使用的补充界面配置。"],
    }, 330),
    chartjs: group("Chart.js 图表", "控制文章中 Chart.js 图表的主题颜色。", {
      enable: ["启用 Chart.js", "开启文章中的 Chart.js 图表渲染。"],
      "fontColor.light": ["浅色模式字体颜色", "图表在浅色主题下的文字颜色。"],
      "fontColor.dark": ["深色模式字体颜色", "图表在深色主题下的文字颜色。"],
      "borderColor.light": ["浅色模式边框颜色", "图表在浅色主题下的网格和边框颜色。"],
      "borderColor.dark": ["深色模式边框颜色", "图表在深色主题下的网格和边框颜色。"],
      "scale_ticks_backdropColor.light": ["浅色刻度背景", "浅色主题下坐标刻度的背景色。"],
      "scale_ticks_backdropColor.dark": ["深色刻度背景", "深色主题下坐标刻度的背景色。"],
    }, 332),
    chat: group("在线聊天入口", "在页面右下角显示客服聊天入口。", {
      use: ["聊天服务", "选择要接入的在线聊天服务。"],
      rightside_button: ["显示侧边按钮", "是否在右下角显示聊天按钮。"],
      button_hide_show: ["允许隐藏按钮", "是否允许访客手动隐藏聊天入口。"],
    }, 334),
    chatra: group("Chatra 客服", "接入 Chatra 在线客服。", {
      id: ["Chatra 站点 ID", "Chatra 后台提供的网站标识。"],
    }, 336),
    clickShowText: group("点击显示文字", "点击页面时在鼠标位置显示文字。", {
      enable: ["启用点击文字", "开启点击页面显示文字的效果。"],
      text: ["显示文字", "点击时显示的文字列表。"],
      fontSize: ["文字大小", "点击文字的字号，例如 15px。"],
      random: ["随机颜色", "每次显示时随机选择文字颜色。"],
      mobile: ["移动端启用", "允许在触屏设备显示该效果。"],
    }, 338),
    click_heart: group("点击爱心", "点击页面时显示爱心粒子。", {
      enable: ["启用点击爱心", "开启点击页面出现爱心的效果。"],
      mobile: ["移动端启用", "允许在触屏设备显示爱心。"],
    }, 340),
    cloudflare_analytics: group("Cloudflare Analytics", "接入 Cloudflare Web Analytics。", {
      ".": ["Cloudflare 令牌", "填写 Cloudflare Analytics 提供的站点令牌。"],
    }, 342),
    copy: group("内容复制", "允许读者复制文章内容并附加版权信息。", {
      enable: ["启用复制功能", "在文章页面启用内容复制按钮或复制监听。"],
      "copyright.enable": ["附加版权信息", "复制内容时自动附加文章版权声明。"],
      "copyright.limit_count": ["版权附加长度", "正文超过该长度时附加版权信息，0 表示不限制。"],
    }, 344),
    cover: group("封面补充设置", "配置文章未设置封面时使用的默认封面。", {
      default_cover: ["默认封面", "文章没有 cover 字段时使用的默认封面图片。", [], "image"],
    }, 346),
    crisp: group("Crisp 客服", "接入 Crisp 在线客服。", {
      website_id: ["Crisp 网站 ID", "Crisp 后台提供的网站标识。"],
    }, 348),
    darkmode: group("自动深色模式", "按时间段自动切换深色和浅色主题。", {
      start: ["深色开始时间", "每天开始使用深色模式的时间。"],
      end: ["深色结束时间", "每天结束深色模式的时间。"],
    }, 350),
    disqus: group("Disqus 评论", "接入 Disqus 评论系统。", {
      shortname: ["Disqus 短名称", "Disqus 站点设置中的 shortname。"],
      apikey: ["Disqus API Key", "可选的 Disqus API 密钥。"],
    }, 352),
    disqusjs: group("DisqusJS 评论", "通过 DisqusJS 在国内网络环境加载 Disqus。", {
      shortname: ["Disqus 短名称", "Disqus 站点 shortname。"],
      apikey: ["Disqus API Key", "Disqus API 访问密钥。"],
      option: ["其他 DisqusJS 参数", "传给 DisqusJS 的补充初始化参数。"],
    }, 354),
    error_404: group("404 页面", "配置自定义 404 页面内容。", {
      enable: ["启用自定义 404", "使用主题提供的 404 页面样式。"],
      subtitle: ["404 副标题", "显示在 404 标题下方的提示文字。"],
      background: ["404 背景图片", "404 页面使用的背景图片路径。", [], "image"],
    }, 356),
    error_img: group("图片失败占位", "图片加载失败时显示的替代图片。", {
      flink: ["友链头像占位", "友链头像加载失败时显示的图片。", [], "image"],
      post_page: ["文章封面占位", "文章封面加载失败时显示的图片。", [], "image"],
    }, 358),
    facebook_comments: group("Facebook 评论", "接入 Facebook Comments 评论框。", {
      app_id: ["应用 ID", "Facebook 应用 App ID。"],
      user_id: ["管理员用户 ID", "用于评论管理的 Facebook 用户 ID。"],
      pageSize: ["每页评论数", "评论框每页显示的评论数量。"],
      order_by: ["评论排序", "按时间或社交相关性排序评论。"],
      lang: ["评论语言", "Facebook 评论框显示的语言代码。"],
    }, 360),
    fireworks: group("烟花特效", "点击页面时显示烟花动画。", {
      enable: ["启用烟花特效", "开启点击页面产生烟花的效果。"],
      zIndex: ["特效层级", "控制烟花画布在页面中的层叠位置。"],
      mobile: ["移动端启用", "允许在移动设备显示烟花。"],
    }, 362),
    footer: group("页脚补充设置", "配置页脚导航链接。", {
      nav: ["页脚导航", "页脚区域显示的导航链接列表。"],
    }, 364),
    giscus: group("Giscus 评论", "基于 GitHub Discussions 的评论系统。", {
      repo: ["仓库地址", "用于存放评论的 GitHub 仓库。"],
      repo_id: ["仓库 ID", "Giscus 配置生成的仓库 ID。"],
      category_id: ["讨论分类 ID", "Giscus 配置生成的 Discussion 分类 ID。"],
      light_theme: ["浅色主题", "浅色模式下使用的 Giscus 主题。"],
      dark_theme: ["深色主题", "深色模式下使用的 Giscus 主题。"],
      js: ["脚本地址", "Giscus 客户端脚本地址。"],
      option: ["其他 Giscus 参数", "传给 Giscus 的补充配置。"],
    }, 366),
    gitalk: group("Gitalk 评论", "基于 GitHub Issues 的评论系统。", {
      client_id: ["GitHub Client ID", "OAuth 应用的 Client ID。"],
      client_secret: ["GitHub Client Secret", "OAuth 应用的 Client Secret。"],
      repo: ["评论仓库", "存储评论 Issue 的 GitHub 仓库。"],
      owner: ["仓库所有者", "评论仓库所属的 GitHub 用户名。"],
      admin: ["管理员用户名", "拥有评论管理权限的 GitHub 用户名。"],
      option: ["其他 Gitalk 参数", "传给 Gitalk 的补充配置。"],
    }, 368),
    google_adsense: group("Google AdSense", "接入 Google AdSense 自动广告。", {
      enable: ["启用 AdSense", "开启 Google AdSense 广告加载。"],
      auto_ads: ["自动广告", "允许 Google 自动在页面中插入广告。"],
      js: ["AdSense 脚本地址", "AdSense 客户端脚本 URL。"],
      client: ["发布商 ID", "Google AdSense 的 ca-pub 发布商 ID。"],
      enable_page_level_ads: ["页面级广告", "启用 AdSense 页面级广告功能。"],
    }, 370),
    google_analytics: group("Google Analytics", "接入 Google Analytics 统计。", {
      ".": ["Google Analytics ID", "填写 GA4 衡量 ID，例如 G-XXXXXXXXXX。"],
    }, 372),
    google_tag_manager: group("Google Tag Manager", "接入 Google Tag Manager 容器。", {
      tag_id: ["GTM 容器 ID", "填写 GTM-XXXXXXX 格式的容器 ID。"],
      domain: ["统计域名", "限定统计代码生效的域名。"],
    }, 374),
    hr_icon: group("文章分隔图标", "配置文章内容末尾的分隔图标。", {
      icon_top: ["分隔图标上方间距", "设置分隔图标与正文之间的上方间距。"],
    }, 376),
    inject: group("自定义注入", "向页面 head 或 body 末尾注入自定义代码。", {
      head: ["Head 注入代码", "在 </head> 前插入的 HTML、CSS 或 JavaScript。"],
      bottom: ["Body 注入代码", "在 </body> 前插入的 HTML、CSS 或 JavaScript。"],
    }, 378),
    knocket: group("Knocket 服务", "接入 Knocket 相关服务。", {
      identifier: ["服务标识", "Knocket 提供的站点或项目标识。"],
    }, 380),
    lazyload: group("懒加载补充设置", "图片懒加载使用的占位图和视觉效果。", {
      placeholder: ["占位图片", "图片尚未加载时显示的占位图路径。", [], "image"],
      blur: ["模糊过渡", "图片加载完成后从模糊效果渐变到清晰。"],
    }, 382),
    lightbox: group("图片灯箱", "点击文章图片时使用灯箱查看大图。", {
      ".": ["图片灯箱模式", "指定图片查看器类型或关闭灯箱功能。"],
    }, 384),
    livere: group("来必力评论", "接入 Livere（来必力）评论系统。", {
      uid: ["Livere UID", "来必力后台提供的站点 UID。"],
    }, 386),
    math: group("数学公式补充设置", "控制 MathJax、KaTeX 和公式显示细节。", {
      use: ["公式渲染引擎", "选择 MathJax、KaTeX 或关闭公式渲染。", options(["mathjax", "MathJax"], ["katex", "KaTeX"], [false, "关闭"])],
      per_page: ["按页面加载公式库", "仅包含公式的页面加载数学库，减少普通页面开销。"],
      hide_scrollbar: ["隐藏公式横向滚动条", "公式过宽时尝试隐藏横向滚动条。"],
      "mathjax.enableMenu": ["MathJax 右键菜单", "允许右键公式查看 MathJax 菜单。"],
      "mathjax.tags": ["MathJax 自动编号", "设置公式编号使用全局还是按分区编号。"],
      "katex.copy_tex": ["复制 TeX 源码", "为 KaTeX 公式提供复制 LaTeX 源码功能。"],
    }, 388),
    mermaid: group("Mermaid 图表补充设置", "控制 Mermaid 代码块渲染和交互。", {
      code_write: ["显示代码编辑区", "在 Mermaid 图表旁提供源码查看或编辑入口。"],
      open_in_new_tab: ["新标签查看图表", "点击图表时在新标签页打开图片。"],
      zoom_pan: ["缩放与平移", "允许对 Mermaid 图表进行缩放和平移。"],
    }, 390),
    microsoft_clarity: group("Microsoft Clarity", "接入 Microsoft Clarity 行为分析。", {
      ".": ["Clarity 项目 ID", "Microsoft Clarity 后台提供的项目标识。"],
    }, 392),
    note: group("提示块补充设置", "控制 Note 提示块的背景和外观。", {
      light_bg_offset: ["浅色背景偏移", "调整浅色模式下 Note 背景颜色的明暗偏移。"],
    }, 394),
    noticeOutdate: group("过期文章提醒", "在发布时间较久的文章上显示提醒。", {
      style: ["提醒样式", "选择 simple 或 flat 两种提示样式。", options(["simple", "简洁"], ["flat", "扁平"])],
      message_prev: ["提醒前缀", "过期提示中位于天数之前的文字。"],
      message_next: ["提醒后缀", "过期提示中位于天数之后的文字。"],
    }, 396),
    photofigcaption: group("图片题注", "为文章图片显示题注和说明。", {
      ".": ["图片题注设置", "控制图片 figcaption 的显示和样式。"],
    }, 398),
    pjax: group("PJAX 无刷新导航", "使用 PJAX 在页面之间无刷新切换。", {
      enable: ["启用 PJAX", "开启局部刷新导航，减少页面闪烁。"],
      exclude: ["排除页面", "列出不参与 PJAX 的页面路径。"],
    }, 400),
    post_meta: group("文章元信息", "控制首页和文章页显示的日期、分类、标签信息。", {
      "page.date_type": ["首页日期来源", "首页文章卡片显示创建时间、更新时间或两者。", options(["created", "创建时间"], ["updated", "更新时间"], ["both", "创建和更新时间"])],
      "page.date_format": ["首页日期格式", "首页日期显示为绝对日期或相对时间。", options(["date", "绝对日期"], ["relative", "相对时间"])],
      "page.categories": ["首页显示分类", "是否在首页文章卡片显示分类。"],
      "page.tags": ["首页显示标签", "是否在首页文章卡片显示标签。"],
      "page.label": ["首页显示字段名", "是否在元信息前显示“发表于”等字段标签。"],
      "post.position": ["文章元信息位置", "文章页元信息靠左或居中显示。", options(["left", "靠左"], ["center", "居中"])],
      "post.date_type": ["文章页日期来源", "文章页显示创建时间、更新时间或两者。", options(["created", "创建时间"], ["updated", "更新时间"], ["both", "创建和更新时间"])],
      "post.date_format": ["文章页日期格式", "文章页日期显示为绝对日期或相对时间。", options(["date", "绝对日期"], ["relative", "相对时间"])],
      "post.categories": ["文章页显示分类", "是否在文章页显示分类。"],
      "post.tags": ["文章页显示标签", "是否在文章页显示标签。"],
      "post.label": ["文章页显示字段名", "是否在文章页元信息前显示字段标签。"],
    }, 402),
    preloader: group("加载动画补充设置", "配置预加载动画使用的外部样式。", {
      pace_css_url: ["Pace 样式地址", "自定义 Pace 加载动画使用的 CSS 地址。"],
    }, 404),
    pwa: group("PWA 补充资源", "配置渐进式网页应用所需的图标和清单。", {
      manifest: ["Web App Manifest", "PWA 清单文件路径。"],
      apple_touch_icon: ["Apple Touch 图标", "添加到 iOS 主屏幕时使用的图标。"],
      favicon_32_32: ["32×32 图标", "PWA 使用的 32×32 网站图标。"],
      favicon_16_16: ["16×16 图标", "PWA 使用的 16×16 网站图标。"],
      mask_icon: ["遮罩图标", "Android 自适应图标使用的遮罩配置。"],
    }, 406),
    remark42: group("Remark42 评论", "接入 Remark42 自托管评论。", {
      host: ["服务地址", "Remark42 服务端地址。"],
      siteId: ["站点 ID", "用于区分当前博客的站点标识。"],
      option: ["其他 Remark42 参数", "传给 Remark42 的补充初始化配置。"],
    }, 408),
    reward: group("文章打赏", "配置文章底部打赏二维码。", {
      QR_code: ["打赏二维码", "配置收款码图片、链接和说明文字。"],
    }, 410),
    rightside_bottom: group("右下角按钮位置", "调整返回顶部等右下角按钮的位置。", {
      ".": ["右下角位置", "设置右下角悬浮按钮距离页面底部的距离。"],
    }, 412),
    rightside_config_animation: group("侧边按钮动画", "控制右下角功能按钮的展开动画。", {
      ".": ["按钮动画样式", "选择右下角按钮的显示和展开动画。"],
    }, 414),
    rightside_item_order: group("右下角按钮顺序", "控制右下角功能按钮的显示和排序。", {
      enable: ["启用自定义顺序", "启用后按自定义列表排列右下角按钮。"],
      hide: ["隐藏的按钮", "列出需要隐藏的右下角功能按钮。"],
      show: ["显示的按钮", "按期望顺序列出需要显示的按钮。"],
    }, 416),
    rightside_scroll_percent: group("滚动进度", "在返回顶部按钮上显示阅读进度。", {
      ".": ["显示滚动百分比", "启用后右下角按钮显示当前页面滚动进度。"],
    }, 418),
    search: group("搜索补充设置", "配置 Algolia、本地搜索和 DocSearch 的细节。", {
      "algolia_search.hitsPerPage": ["Algolia 每页结果", "Algolia 搜索每次返回的结果数量。"],
      "local_search.pagination.enable": ["本地搜索分页", "启用本地搜索结果分页。"],
      "local_search.pagination.hitsPerPage": ["本地搜索每页结果", "本地搜索每页显示的结果数量。"],
      "local_search.CDN": ["本地搜索 CDN", "加载本地搜索脚本使用的 CDN 前缀。"],
      "docsearch.appId": ["DocSearch App ID", "Algolia DocSearch 应用 ID。"],
      "docsearch.apiKey": ["DocSearch API Key", "Algolia DocSearch 公共搜索密钥。"],
      "docsearch.indexName": ["DocSearch 索引名", "Algolia 中的搜索索引名称。"],
      "docsearch.option": ["其他 DocSearch 参数", "传给 DocSearch 的补充配置。"],
    }, 420),
    series: group("文章系列", "把同一系列的文章自动关联起来。", {
      enable: ["启用文章系列", "开启系列文章导航和页面。"],
      orderBy: ["系列排序依据", "按标题或日期排列系列文章。", options(["title", "标题"], ["date", "日期"])],
      order: ["系列排序方向", "1 为升序，-1 为降序。"],
      number: ["显示系列序号", "在系列文章标题前显示编号。"],
    }, 422),
    site_verification: group("站点验证", "为搜索引擎站长平台放置验证代码。", {
      ".": ["站点验证代码", "填写 Google、百度等平台提供的站点验证 HTML。"],
    }, 424),
    snackbar: group("Snackbar 补充设置", "配置消息条在不同主题下的背景色。", {
      bg_light: ["浅色模式背景", "浅色主题下 Snackbar 的背景颜色。"],
      bg_dark: ["深色模式背景", "深色主题下 Snackbar 的背景颜色。"],
    }, 426),
    structured_data: group("结构化数据补充设置", "补充搜索引擎使用的结构化数据。", {
      alternate_name: ["站点别名", "结构化数据中使用的站点别名列表。"],
    }, 428),
    subtitle: group("副标题补充设置", "配置副标题打字动画的详细参数。", {
      typed_option: ["Typed.js 参数", "传给打字机插件的选项对象。"],
    }, 430),
    tag_per_img: group("标签页顶部图", "为不同标签配置各自的顶部图片。", {
      ".": ["标签图片映射", "按标签名称设置对应的顶部图片路径。"],
    }, 432),
    tag_ui: group("标签页 UI", "自定义标签页面的布局与显示元素。", {
      ".": ["标签页界面选项", "标签页面使用的补充界面配置。"],
    }, 434),
    tidio: group("Tidio 客服", "接入 Tidio 在线客服。", {
      public_key: ["Tidio 公钥", "Tidio 后台提供的 Public Key。"],
    }, 436),
    translate: group("页面翻译", "为博客启用第三方翻译功能。", {
      enable: ["启用翻译", "显示简体/繁体或第三方翻译入口。"],
      default: ["默认语言", "页面翻译功能默认使用的语言。"],
      defaultEncoding: ["默认编码", "翻译服务返回内容时使用的字符编码。"],
      translateDelay: ["翻译延迟", "触发翻译前等待的毫秒数。"],
      msgToTraditionalChinese: ["转为繁体按钮文字", "“转换为繁体中文”按钮的提示文字。"],
      msgToSimplifiedChinese: ["转为简体按钮文字", "“转换为简体中文”按钮的提示文字。"],
    }, 438),
    twikoo: group("Twikoo 评论", "接入 Twikoo 评论服务。", {
      envId: ["环境 ID", "云函数或自部署服务的环境标识。"],
      region: ["服务区域", "Twikoo 云环境所在区域。"],
      visitor: ["访客统计", "控制 Twikoo 访客统计方式。"],
      option: ["其他 Twikoo 参数", "传给 Twikoo 的补充初始化配置。"],
    }, 440),
    umami_analytics: group("Umami 统计", "接入 Umami 网站分析服务。", {
      enable: ["启用 Umami", "开启 Umami 统计脚本。"],
      serverURL: ["服务地址", "Umami 自托管服务的访问地址。"],
      script_name: ["脚本文件名", "Umami 统计脚本的文件名。"],
      website_id: ["网站 ID", "Umami 后台提供的网站标识。"],
      option: ["其他 Umami 参数", "传给 Umami 脚本的补充属性。"],
      "UV_PV.site_uv": ["显示站点访客数", "在页面中显示站点独立访客统计。"],
      "UV_PV.site_pv": ["显示站点访问量", "在页面中显示站点总访问量。"],
      "UV_PV.page_pv": ["显示页面访问量", "在页面中显示当前页面访问量。"],
      "UV_PV.token": ["统计接口令牌", "读取 Umami 统计数据所需的访问令牌。"],
    }, 442),
    utterances: group("Utterances 评论", "基于 GitHub Issues 的轻量评论系统。", {
      repo: ["评论仓库", "存储评论 Issue 的 GitHub 仓库。"],
      issue_term: ["Issue 映射方式", "决定每篇文章对应哪个 GitHub Issue。"],
      light_theme: ["浅色主题", "浅色模式下使用的 Utterances 主题。"],
      dark_theme: ["深色主题", "深色模式下使用的 Utterances 主题。"],
      js: ["脚本地址", "Utterances 客户端脚本地址。"],
      option: ["其他 Utterances 参数", "传给 Utterances 的补充配置。"],
    }, 444),
    valine: group("Valine 评论", "接入 LeanCloud 上的 Valine 评论。", {
      appId: ["LeanCloud App ID", "LeanCloud 应用的 App ID。"],
      appKey: ["LeanCloud App Key", "LeanCloud 应用的 App Key。"],
      avatar: ["头像服务", "评论头像使用的第三方头像服务。"],
      serverURLs: ["自定义服务地址", "LeanCloud 自定义 API 域名。"],
      bg: ["评论框背景", "评论输入框使用的背景图片。"],
      visitor: ["访客统计", "控制 Valine 访客统计方式。"],
      option: ["其他 Valine 参数", "传给 Valine 的补充初始化配置。"],
    }, 446),
    waline: group("Waline 评论", "接入 Waline 自托管评论服务。", {
      serverURL: ["服务地址", "Waline 服务端地址。"],
      bg: ["评论框背景", "Waline 评论框的背景图片。"],
      pageview: ["阅读量统计", "是否在文章中显示 Waline 阅读量。"],
      option: ["其他 Waline 参数", "传给 Waline 的补充初始化配置。"],
    }, 448),
    wordcount: group("文章字数统计", "显示文章字数和预计阅读时间。", {
      enable: ["启用字数统计", "开启文章字数统计功能。"],
      post_wordcount: ["文章页字数", "在文章页显示本文总字数。"],
      min2read: ["预计阅读时间", "按阅读速度估算并显示阅读所需时间。"],
      total_wordcount: ["全站总字数", "在页面或侧边栏显示全站累计字数。"],
    }, 450),
  };

  window.CONFIG_METADATA = {
    fallbackDescription,
    site,
    theme,
  };
}());