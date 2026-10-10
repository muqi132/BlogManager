"use strict";

const SCHEMA = window.CONFIG_SCHEMA;
const CONFIG_FALLBACK_DESCRIPTION = window.CONFIG_METADATA?.fallbackDescription || "暂无说明，建议参考官方文档";
const THEME_SOURCE_URLS = {
  github: "https://github.com/jerryc127/hexo-theme-butterfly.git",
  gitee: "https://gitee.com/jerryc127/hexo-theme-butterfly.git",
  ghproxy: "https://ghproxy.com/https://github.com/jerryc127/hexo-theme-butterfly.git",
  moeyy: "https://github.moeyy.xyz/https://github.com/jerryc127/hexo-theme-butterfly.git",
  "gh-proxy": "https://gh-proxy.com/https://github.com/jerryc127/hexo-theme-butterfly.git",
};
const markdownRenderer = window.markdownit ? window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, language) {
    if (!window.hljs) return "";
    try {
      const result = language && window.hljs.getLanguage(language)
        ? window.hljs.highlight(code, { language })
        : window.hljs.highlightAuto(code);
      return `<pre class="hljs"><code>${result.value}</code></pre>`;
    } catch (_error) {
      return "";
    }
  },
}) : null;

// KaTeX 默认信任 \href / \url 的任意协议。文章内容可能来自克隆的第三方仓库，
// 而预览运行在本机应用源下（可调用本地 API 写删文件），因此只放行 http(s)。
const SAFE_MATH_PROTOCOLS = new Set(["http:", "https:"]);
function katexTrustPolicy(context) {
  if (!context || context.command !== "\\href") return false;
  try {
    return SAFE_MATH_PROTOCOLS.has(new URL(String(context.url || ""), "http://localhost").protocol);
  } catch (_error) {
    return false;
  }
}
const state = {
  status: null,
  activeTaskId: null,
  activeTaskKind: null,
  eventSource: null,
  logEntries: [],
  logHistory: { offset: 0, lines: [], total: 0, hasMore: false, loading: false },
  pendingDeploy: false,
  allowUnload: false,
  posts: [],
  postFolder: "",
  frontmatter: { selectedPath: "", properties: [], invalid: false, loading: false, loadToken: 0 },
  cover: { relativePath: "", currentCover: "", selectedValue: "", externalValue: "", newImages: new Set(), properties: [], loadToken: 0 },
  postFoldersExpanded: new Set([""]),
  postSelection: { active: false, selected: new Set(), visiblePaths: [] },
  autoDeploy: { target: "", mode: "create", inspect: null, preflight: null, repoManual: false, settingRepo: false, localOnly: false, skipTheme: false, progressTaskId: "", tokenSet: false },
  previewDependencies: null,
  images: [],
  imageViewer: { relativePath: "", name: "", url: "", size: 0, width: 0, height: 0, scale: 1, rotation: 0, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 },
  editor: { relativePath: "", content: "", original: "", dirty: false, renderTimer: null, composing: false, codeTokens: [], highlightPending: false },
  configImage: { kind: "", path: "", selected: "", external: "", images: [], newImages: new Set(), loadToken: 0 },
  site: {
    loaded: false,
    dirty: false,
    mode: "fields",
    values: {},
    baseValues: {},
    fieldDescriptions: {},
    overridePaths: new Set(),
    dirtyPaths: new Set(),
    resetPaths: new Set(),
    fieldMap: new Map(),
    groups: SCHEMA.siteGroups,
    searchTerm: "",
  },
  theme: {
    loaded: false,
    dirty: false,
    mode: "fields",
    values: {},
    baseValues: {},
    overridePaths: new Set(),
    dirtyPaths: new Set(),
    resetPaths: new Set(),
    fieldMap: new Map(),
    groups: SCHEMA.themeGroups,
    fieldDescriptions: {},
    menuItems: [],
    menuSimple: true,
    menuOriginal: [],
    menuDirty: false,
    socialItems: [],
    socialSimple: true,
    socialOriginal: [],
    socialDirty: false,
    searchTerm: "",
  },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

async function api(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const settings = { ...options, headers: isFormData ? { ...(options.headers || {}) } : { "Content-Type": "application/json", ...(options.headers || {}) } };
  const response = await fetch(path, settings);
  let data = {};
  try { data = await response.json(); } catch (_error) { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.details = data.details || null;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setButtonBusy(button, busy, busyLabel = "处理中...") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<svg class="spin"><use href="#i-sun"></use></svg><span>${busyLabel}</span>`;
  } else {
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
    button.disabled = false;
  }
}

function toast(title, message = "", type = "info", timeout = 4200) {
  const stack = $("#toastStack");
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  const icon = document.createElement("div");
  icon.className = "toast-icon";
  icon.innerHTML = '<svg><use href="#i-check"></use></svg>';
  const copy = document.createElement("div");
  copy.className = "toast-copy";
  const heading = document.createElement("strong");
  heading.textContent = title;
  copy.append(heading);
  if (message) {
    const body = document.createElement("span");
    body.textContent = message;
    copy.append(body);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "×";
  close.addEventListener("click", () => item.remove());
  item.append(icon, copy, close);
  stack.append(item);
  window.setTimeout(() => item.remove(), timeout);
}

function initPanelTheme() {
  const saved = localStorage.getItem("blog-manager-panel-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  else if (!document.documentElement.dataset.theme) {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
}

function updateHighlightTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  const light = $("#highlightLightTheme");
  const darkTheme = $("#highlightDarkTheme");
  if (light) light.disabled = dark;
  if (darkTheme) darkTheme.disabled = !dark;
}

function togglePanelTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("blog-manager-panel-theme", next);
  updateHighlightTheme();
}

function getPath(object, path, fallback = undefined) {
  let current = object;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object" || !(part in current)) return fallback;
    current = current[part];
  }
  return current;
}

function activateSection(name) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.section === name));
  $$(".page-section").forEach((section) => section.classList.toggle("active", section.dataset.sectionPanel === name));
  $("#contentScroll").scrollTop = 0;
  localStorage.setItem("blog-manager-section", name);
  if (name !== "posts" && state.postSelection.active) setPostSelectionMode(false);
  if (name === "posts") loadPosts();
  if (name === "images") loadImages();
}

function markDirty(kind) {
  const config = state[kind];
  const specialDirty = kind === "theme" && (state.theme.menuDirty || state.theme.socialDirty);
  config.dirty = config.dirtyPaths.size > 0 || config.resetPaths.size > 0 || specialDirty;
  const hint = kind === "site" ? $("#siteSaveHint") : $("#themeSaveHint");
  if (hint) {
    hint.textContent = config.dirty ? "有未保存的修改" : "配置已加载";
    hint.className = `save-state ${config.dirty ? "dirty" : ""}`.trim();
  }
}

function clearDirty(kind) {
  state[kind].dirty = false;
  state[kind].dirtyPaths.clear();
  state[kind].resetPaths.clear();
  if (kind === "theme") {
    state.theme.menuDirty = false;
    state.theme.socialDirty = false;
  }
}

function hasUnsavedChanges() {
  return state.site.dirty || state.theme.dirty;
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function valuesEqual(left, right) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch (_error) { return false; }
}

function humanizeConfigKey(key) {
  const known = {
    url: "URL", cdn: "CDN", pwa: "PWA", seo: "SEO", id: "ID", css: "CSS", js: "JS",
    mathjax: "MathJax", open_graph: "Open Graph", structured_data: "结构化数据",
  };
  if (known[key]) return known[key];
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function isImageConfigPath(path) {
  const key = String(path || "").split(".").pop() || "";
  return /^(favicon|.*_?img|image|logo|background)$/i.test(key)
    && !/(height|width|enable|effect|position|size)$/i.test(key);
}

function inferConfigType(path, value, baseValue) {
  const sample = value !== undefined ? value : baseValue;
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return "number";
  if (Array.isArray(sample)) {
    return sample.every((item) => ["string", "number", "boolean"].includes(typeof item)) ? "list" : "yaml";
  }
  if (sample && typeof sample === "object") return "yaml";
  if (isImageConfigPath(path)) return "image";
  return "text";
}

function flattenConfigValues(value, prefix, output) {
  if (Array.isArray(value)) {
    output.push({ path: prefix, value, type: inferConfigType(prefix, value, undefined) });
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length && prefix) {
      output.push({ path: prefix, value, type: "yaml" });
      return;
    }
    for (const [key, child] of entries) {
      if (key.includes(".")) continue;
      const childPath = prefix ? `${prefix}.${key}` : key;
      flattenConfigValues(child, childPath, output);
    }
    return;
  }
  output.push({ path: prefix, value });
}

function configMetadataFor(kind, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  const metadataRoot = CONFIG_METADATA[kind] || {};
  const groupMetadata = metadataRoot[parts[0]] || null;
  const relativePath = parts.length > 1 ? parts.slice(1).join(".") : ".";
  const fieldMetadata = metadataRoot.staticFields?.[path]
    || groupMetadata?.fields?.[relativePath]
    || groupMetadata?.fields?.[path]
    || groupMetadata?.fields?.["*"]
    || null;
  return { group: groupMetadata, field: fieldMetadata };
}

function hasChineseText(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ""));
}

function resolveConfigDescription(kind, path, fallbackText = "") {
  const metadata = configMetadataFor(kind, path);
  const yamlDescription = state[kind]?.fieldDescriptions?.[path] || "";
  if (metadata.field?.description) return metadata.field.description;
  if (hasChineseText(yamlDescription)) return yamlDescription;
  if (hasChineseText(fallbackText)) return fallbackText;
  return CONFIG_FALLBACK_DESCRIPTION;
}

function buildDynamicConfigGroups(kind, values) {
  const config = state[kind];
  const staticPaths = new Set();
  config.groups.filter((group) => !group.dynamic).forEach((group) => {
    group.fields.forEach((field) => staticPaths.add(field.path));
  });
  if (kind === "theme") {
    staticPaths.add("menu");
    staticPaths.add("social");
  }
  const leaves = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (kind === "theme" && ["menu", "social"].includes(key)) continue;
    flattenConfigValues(value, key, leaves);
  }
  const grouped = new Map();
  for (const leaf of leaves) {
    if (!leaf.path || staticPaths.has(leaf.path)) continue;
    const top = leaf.path.split(".")[0];
    if (!grouped.has(top)) grouped.set(top, []);
    const baseValue = getPath(config.baseValues, leaf.path);
    const metadata = configMetadataFor(kind, leaf.path);
    const fieldOptions = Array.isArray(metadata.field?.options) ? metadata.field.options : [];
    const type = fieldOptions.length ? "select" : inferConfigType(leaf.path, leaf.value, baseValue);
    const hint = resolveConfigDescription(kind, leaf.path);
    grouped.get(top).push({
      path: leaf.path,
      label: metadata.field?.label || humanizeConfigKey(leaf.path.split(".").pop()),
      type,
      options: fieldOptions,
      imagePicker: metadata.field?.type === "image" || type === "image",
      hint,
      title: hint,
      dynamic: true,
      default: baseValue,
    });
  }
  return Array.from(grouped.entries())
    .map(([top, fields]) => {
      const metadata = configMetadataFor(kind, top);
      return {
        id: `dynamic-${kind}-${top}`,
        title: metadata.group?.title || `高级配置 · ${humanizeConfigKey(top)}`,
        description: metadata.group?.description || CONFIG_FALLBACK_DESCRIPTION,
        order: metadata.group?.order ?? 999,
        dynamic: true,
        fields: fields.sort((a, b) => a.path.localeCompare(b.path, "zh-CN")),
      };
    })
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN"));
}

function rebuildConfigGroups(kind) {
  const config = state[kind];
  const staticGroups = kind === "site" ? SCHEMA.siteGroups : SCHEMA.themeGroups;
  config.groups = [
    ...staticGroups,
    ...buildDynamicConfigGroups(kind, config.values),
  ];
  config.fieldMap = new Map();
  config.groups.forEach((group) => group.fields.forEach((field) => config.fieldMap.set(field.path, field)));
}

function createControl(field, value) {
  if (field.type === "boolean") {
    const label = document.createElement("label");
    label.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(value);
    input.dataset.path = field.path;
    input.dataset.type = "boolean";
    const track = document.createElement("span");
    track.className = "switch-track";
    const thumb = document.createElement("span");
    thumb.className = "switch-thumb";
    track.append(thumb);
    label.append(input, track);
    return label;
  }
  if (field.imagePicker || field.type === "image") {
    const wrap = document.createElement("div");
    wrap.className = "image-path-control";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "setting-control mono";
    input.dataset.path = field.path;
    input.dataset.type = "text";
    input.value = value == null ? "" : String(value);
    input.placeholder = field.placeholder || "/img/example.png 或 https://...";
    const picker = document.createElement("button");
    picker.type = "button";
    picker.className = "button secondary image-picker-button";
    picker.dataset.imagePickerPath = field.path;
    picker.innerHTML = '<svg><use href="#i-image"></use></svg><span>选择图片</span>';
    wrap.append(input, picker);
    return wrap;
  }
  if (field.type === "select" || field.type === "selectOrText") {
    const wrap = document.createElement("div");
    const select = document.createElement("select");
    select.className = "setting-control";
    select.dataset.path = field.path;
    select.dataset.type = "select";
    select.dataset.options = JSON.stringify(field.options || []);
    const current = value ?? "";
    let found = false;
    (field.options || []).forEach((option) => {
      const item = document.createElement("option");
      item.value = String(option.value);
      item.textContent = option.label || String(option.value);
      if (String(option.value) === String(current)) found = true;
      select.append(item);
    });
    if (!found) {
      const item = document.createElement("option");
      item.value = String(current);
      item.textContent = current === "" ? "（空值）" : String(current);
      select.prepend(item);
    }
    wrap.append(select);
    if (field.allowCustom) {
      const known = (field.options || []).some((option) => String(option.value) === String(current));
      const custom = document.createElement("input");
      custom.type = "text";
      custom.className = "setting-control custom-control";
      custom.placeholder = "自定义值";
      custom.value = known ? "" : String(current ?? "");
      custom.classList.toggle("hidden", known);
      custom.dataset.path = field.path;
      custom.dataset.type = "custom";
      select.value = known ? String(current) : "__custom__";
      const customOption = document.createElement("option");
      customOption.value = "__custom__";
      customOption.textContent = "其他 / 自定义";
      select.append(customOption);
      select.addEventListener("change", () => custom.classList.toggle("hidden", select.value !== "__custom__"));
      wrap.append(custom);
    }
    return wrap;
  }
  if (field.type === "list") {
    const textarea = document.createElement("textarea");
    textarea.className = "setting-control mono";
    textarea.rows = 4;
    textarea.dataset.path = field.path;
    textarea.dataset.type = "list";
    textarea.value = Array.isArray(value) ? value.join("\n") : value ? String(value) : "";
    textarea.placeholder = field.placeholder || "每行一项";
    return textarea;
  }
  if (field.type === "yaml") {
    const textarea = document.createElement("textarea");
    textarea.className = "setting-control mono";
    textarea.rows = 5;
    textarea.dataset.path = field.path;
    textarea.dataset.type = "yaml";
    const safeValue = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
    textarea.value = safeValue;
    textarea.placeholder = field.placeholder || "YAML";
    return textarea;
  }
  const tag = field.type === "textarea" ? "textarea" : "input";
  const control = document.createElement(tag);
  control.className = `setting-control ${field.mono ? "mono" : ""}`.trim();
  control.dataset.path = field.path;
  control.dataset.type = field.type || "text";
  if (tag === "textarea") {
    control.rows = 3;
    control.value = value == null ? "" : String(value);
  } else {
    control.type = field.type === "number" ? "number" : "text";
    control.value = value == null ? "" : String(value);
  }
  if (field.placeholder) control.placeholder = field.placeholder;
  if (field.min !== undefined) control.min = String(field.min);
  if (field.max !== undefined) control.max = String(field.max);
  if (field.listId) control.setAttribute("list", field.listId);
  return control;
}

function formatDefaultValue(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readConfigPathValue(container, path) {
  const controls = $$(`[data-path="${CSS.escape(path)}"]`, container);
  if (!controls.length) return undefined;
  const visible = controls.filter((control) => !control.classList.contains("hidden"));
  const custom = visible.find((control) => control.dataset.type === "custom");
  const select = visible.find((control) => control.dataset.type === "select");
  if (custom && (!select || select.value === "__custom__")) return custom.value;
  const control = visible[0] || controls[0];
  const type = control.dataset.type;
  if (type === "boolean") return control.checked;
  if (type === "number") return control.value === "" ? null : Number(control.value);
  if (type === "list") {
    const kind = container.id === "siteFields" ? "site" : "theme";
    const path = control.dataset.path;
    const original = getPath(state[kind].values, path);
    const samples = Array.isArray(original) ? original : [];
    return control.value.split(/\r?\n/).map((item, index) => {
      const textValue = item.trim();
      const sample = samples[index] ?? samples[0];
      if (typeof sample === "number" && textValue !== "" && Number.isFinite(Number(textValue))) return Number(textValue);
      if (typeof sample === "boolean") return ["true", "1", "yes", "on"].includes(textValue.toLowerCase());
      return textValue;
    }).filter((item) => item !== "");
  }
  if (type === "select") {
    const options = JSON.parse(control.dataset.options || "[]");
    const matched = options.find((option) => String(option.value) === String(control.value));
    return matched ? matched.value : control.value;
  }
  return control.value;
}

function setConfigPathValue(container, path, value) {
  const controls = $$(`[data-path="${CSS.escape(path)}"]`, container);
  const select = controls.find((control) => control.dataset.type === "select");
  const custom = controls.find((control) => control.dataset.type === "custom");
  if (select) {
    const known = Array.from(select.options).some((option) => option.value === String(value ?? ""));
    if (known && String(value ?? "") !== "__custom__") {
      select.value = String(value ?? "");
      if (custom) custom.classList.add("hidden");
    } else if (custom) {
      select.value = "__custom__";
      custom.classList.remove("hidden");
      custom.value = value == null ? "" : String(value);
    }
  }
  controls.forEach((control) => {
    const type = control.dataset.type;
    if (type === "select") return;
    if (type === "boolean") control.checked = Boolean(value);
    else if (type === "list") control.value = Array.isArray(value) ? value.join("\n") : (value == null ? "" : String(value));
    else if (type === "custom") {
      if (control.classList.contains("hidden")) return;
      control.value = value == null ? "" : String(value);
    } else if (type === "yaml" && typeof value !== "string") control.value = JSON.stringify(value ?? null, null, 2);
    else control.value = value == null ? "" : String(value);
  });
}

function updateResetButton(kind, path) {
  const config = state[kind];
  const cell = $(`[data-config-field="${CSS.escape(path)}"]`);
  if (!cell) return;
  const button = $(".field-reset-button", cell);
  if (!button) return;
  const active = config.resetPaths.has(path);
  button.classList.toggle("active", active);
  button.textContent = active ? "已重置" : "重置默认";
  button.title = active ? "保存后将从根目录覆盖文件删除此键" : "删除根目录覆盖文件中的此键";
}

function handleConfigControlChange(kind, control) {
  const path = control.dataset.path;
  if (!path) return;
  const config = state[kind];
  const container = kind === "site" ? $("#siteFields") : $("#themeFields");
  const value = readConfigPathValue(container, path);
  const original = getPath(config.values, path);
  if (valuesEqual(value, original)) config.dirtyPaths.delete(path);
  else config.dirtyPaths.add(path);
  if (!config.resetPaths.has(path) || !valuesEqual(value, getPath(config.baseValues, path))) {
    config.resetPaths.delete(path);
  }
  updateResetButton(kind, path);
  markDirty(kind);
}

function resetConfigField(kind, path) {
  const config = state[kind];
  const container = kind === "site" ? $("#siteFields") : $("#themeFields");
  config.resetPaths.add(path);
  config.dirtyPaths.delete(path);
  setConfigPathValue(container, path, getPath(config.baseValues, path));
  updateResetButton(kind, path);
  markDirty(kind);
}

function renderConfigGroups(container, groups, values, kind) {
  container.replaceChildren();
  groups.forEach((group, groupIndex) => {
    const card = document.createElement("details");
    card.className = `config-group ${group.dynamic ? "dynamic-config-group" : ""}`.trim();
    card.dataset.groupId = group.id;
    const defaultOpen = group.defaultOpen !== undefined ? group.defaultOpen : groupIndex < 3;
    card.open = defaultOpen;
    card.dataset.defaultOpen = defaultOpen ? "true" : "false";
    const heading = document.createElement("summary");
    heading.className = "group-heading";
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = group.title;
    const description = document.createElement("p");
    description.textContent = group.description || "";
    copy.append(title, description);
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(group.fields.length);
    heading.append(copy, count);
    const grid = document.createElement("div");
    grid.className = "group-fields";
    group.fields.forEach((field) => {
      const cell = document.createElement("div");
      cell.className = `setting-field ${field.span === 2 ? "span-2" : ""} ${field.type === "boolean" ? "boolean-field" : ""}`.trim();
      cell.dataset.configField = field.path;
      const metadata = configMetadataFor(kind, field.path);
      const displayHint = field.hint || metadata.field?.description || resolveConfigDescription(kind, field.path);
      const textWrap = document.createElement("div");
      const label = document.createElement("label");
      label.className = "setting-label";
      label.textContent = metadata.field?.label || field.label;
      const pathLabel = document.createElement("span");
      pathLabel.className = "setting-path";
      pathLabel.textContent = field.path;
      textWrap.append(label, pathLabel);
      if (displayHint) {
        const hint = document.createElement("small");
        hint.className = `setting-hint${field.dynamic ? " clamped" : ""}`;
        hint.textContent = displayHint;
        hint.title = field.title || displayHint;
        textWrap.append(hint);
      }
      const defaultValue = field.default !== undefined ? field.default : getPath(state[kind].baseValues, field.path);
      if (defaultValue !== undefined) {
        const defaultHint = document.createElement("small");
        defaultHint.className = "setting-default";
        defaultHint.textContent = `默认：${formatDefaultValue(defaultValue)}`;
        textWrap.append(defaultHint);
      }
      const control = createControl(field, getPath(values, field.path));
      cell.append(textWrap, control);
      if (kind === "theme" && (state.theme.overridePaths.has(field.path) || state.theme.resetPaths.has(field.path))) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "field-reset-button";
        reset.dataset.resetPath = field.path;
        reset.textContent = state.theme.resetPaths.has(field.path) ? "已重置" : "重置默认";
        if (state.theme.resetPaths.has(field.path)) reset.classList.add("active");
        reset.title = "删除根目录覆盖文件中的此键";
        cell.append(reset);
      }
      grid.append(cell);
    });
    card.append(heading, grid);
    container.append(card);
  });
  $$("input, select, textarea", container).forEach((control) => {
    if (!control.dataset.path) return;
    control.addEventListener("input", () => handleConfigControlChange(kind, control));
    control.addEventListener("change", () => handleConfigControlChange(kind, control));
  });
  $$("[data-image-picker-path]", container).forEach((button) => {
    button.addEventListener("click", () => openConfigImagePicker(kind, button.dataset.imagePickerPath));
  });
  $$("[data-reset-path]", container).forEach((button) => {
    button.addEventListener("click", () => resetConfigField(kind, button.dataset.resetPath));
  });
  applyConfigSearch(kind);
}

function collectConfigChanges(kind, container) {
  const config = state[kind];
  const changes = {};
  const resetPaths = new Set(config.resetPaths);
  config.dirtyPaths.forEach((path) => {
    if (resetPaths.has(path)) return;
    const field = config.fieldMap.get(path) || {};
    let value = readConfigPathValue(container, path);
    const type = field.type || ($$(`[data-path="${CSS.escape(path)}"]`, container)[0]?.dataset.type || "text");
    if (type === "number" && value === null) {
      resetPaths.add(path);
      return;
    }
    if (type === "image") value = String(value ?? "");
    changes[path] = { type, value };
  });
  return { changes, reset_paths: Array.from(resetPaths) };
}

function applyConfigSearch(kind) {
  const term = String(state[kind].searchTerm || "").trim().toLocaleLowerCase("zh-CN");
  const container = kind === "site" ? $("#siteFields") : $("#themeFields");
  if (!container) return;
  $$(".config-group", container).forEach((group) => {
    const groupTitle = $(".group-heading h2", group)?.textContent || "";
    const groupDescription = $(".group-heading p", group)?.textContent || "";
    const groupMatches = term && `${groupTitle} ${groupDescription}`.toLocaleLowerCase("zh-CN").includes(term);
    let visibleFields = 0;
    $$(".setting-field", group).forEach((field) => {
      const haystack = `${field.textContent} ${field.dataset.configField || ""}`.toLocaleLowerCase("zh-CN");
      const match = !term || groupMatches || haystack.includes(term);
      field.classList.toggle("hidden", !match);
      if (match) visibleFields += 1;
    });
    group.classList.toggle("hidden", Boolean(term) && !groupMatches && visibleFields === 0);
    if (term && (groupMatches || visibleFields > 0)) group.open = true;
    else if (!term) group.open = group.dataset.defaultOpen === "true";
  });
}

function setConfigMode(kind, mode) {
  const config = state[kind];
  if (mode === "raw" && config.dirty) {
    toast("请先保存当前表单", "保存后再切换到 YAML 模式，避免覆盖未保存内容。", "warning");
    return;
  }
  if (mode === "fields" && config.rawDirty) {
    toast("YAML 修改尚未保存", "切换回表单会暂时保留磁盘上的已保存值。", "warning");
  }
  config.mode = mode;
  config.rawDirty = false;
  const switchId = kind === "site" ? "#siteModeSwitch" : "#themeModeSwitch";
  $$("button", $(switchId)).forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $(kind === "site" ? "#siteFields" : "#themeFields").classList.toggle("hidden", mode !== "fields");
  $(kind === "site" ? "#siteRawEditor" : "#themeRawEditor").classList.toggle("hidden", mode !== "raw");
  if (kind === "theme") $$(".menu-card", $("#themeForm")).forEach((card) => card.classList.toggle("hidden", mode !== "fields"));
}

async function loadStatus(options = {}) {
  const { attachPreview = true } = options;
  state.status = await api("/api/status", { cache: "no-store" });
  $("#pathText").textContent = state.status.blog_dir;
  $("#pathDisplay").title = state.status.blog_dir;
  $("#serverDot").className = `status-dot ${state.status.exists ? "online" : "error"}`;
  $("#serverLabel").textContent = state.status.exists ? "服务已连接" : "博客目录不可用";
  $("#siteConfigNotice").classList.toggle("hidden", state.status.site_config_exists);
  $("#themeConfigNotice").classList.toggle("hidden", state.status.theme_config_exists);
  applyProjectMode(Boolean(state.status.local_only));
  updatePreviewUi(state.status.preview);
  if (attachPreview && state.status.preview?.status === "running" && !state.activeTaskId) {
    attachTask(state.status.preview, { preserveLog: true, quiet: true });
  }
}

async function loadSiteConfig(options = {}) {
  const { quiet = false } = options;
  try {
    const data = await api("/api/site-config", { cache: "no-store" });
    state.site.values = data.values || {};
    state.site.baseValues = data.base_values || {};
    state.site.fieldDescriptions = data.field_descriptions || {};
    state.site.overridePaths = new Set(data.override_paths || []);
    state.site.loaded = true;
    state.site.rawDirty = false;
    state.site.dirtyPaths = new Set();
    state.site.resetPaths = new Set();
    state.site.dirty = false;
    rebuildConfigGroups("site");
    renderConfigGroups($("#siteFields"), state.site.groups, state.site.values, "site");
    $("#siteRawYaml").value = data.raw_yaml || "";
    $("#siteSaveHint").textContent = "配置已加载"; $("#siteSaveHint").className = "save-state";
    if (!quiet) toast("站点配置已刷新", "", "success", 2200);
  } catch (error) {
    state.site.loaded = false;
    $("#siteSaveHint").textContent = error.message; $("#siteSaveHint").className = "save-state dirty";
    if (!quiet) toast("无法加载站点配置", error.message, "error");
  }
}

async function saveSiteConfig(event) {
  event.preventDefault();
  if (!state.site.loaded) return;
  const button = $("#saveSiteButton");
  setButtonBusy(button, true, "正在保存...");
  try {
    let payload;
    if (state.site.mode === "raw") {
      payload = { mode: "raw", raw_yaml: $("#siteRawYaml").value };
    } else {
      const fieldChanges = collectConfigChanges("site", $("#siteFields"));
      if (!Object.keys(fieldChanges.changes).length && !fieldChanges.reset_paths.length) {
        toast("没有需要保存的修改", "表单值没有变化。", "info", 2200);
        return;
      }
      payload = { mode: "fields", changes: fieldChanges.changes, reset_paths: fieldChanges.reset_paths };
    }
    await api("/api/site-config", { method: "PUT", body: JSON.stringify(payload) });
    await loadSiteConfig({ quiet: true });
    $("#siteSaveHint").textContent = `已保存 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`; $("#siteSaveHint").className = "save-state saved";
    toast("站点配置已保存", "只写入了本次修改的字段。", "success");
  } catch (error) {
    toast("保存失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadThemeConfig(options = {}) {
  const { quiet = false } = options;
  try {
    const data = await api("/api/theme-config", { cache: "no-store" });
    state.theme.values = data.values || {};
    state.theme.baseValues = data.base_values || {};
    state.theme.fieldDescriptions = data.field_descriptions || {};
    state.theme.overridePaths = new Set(data.override_paths || []);
    state.theme.loaded = true;
    state.theme.rawDirty = false;
    state.theme.menuItems = Array.isArray(data.menu_items) ? data.menu_items : [];
    state.theme.socialItems = Array.isArray(data.social_items) ? data.social_items : [];
    state.theme.menuSimple = Boolean(data.menu_is_simple);
    state.theme.socialSimple = Boolean(data.social_is_simple);
    state.theme.menuOriginal = cloneValue(state.theme.menuItems);
    state.theme.socialOriginal = cloneValue(state.theme.socialItems);
    state.theme.menuDirty = false;
    state.theme.socialDirty = false;
    state.theme.dirtyPaths = new Set();
    state.theme.resetPaths = new Set();
    state.theme.dirty = false;
    rebuildConfigGroups("theme");
    renderConfigGroups($("#themeFields"), state.theme.groups, state.theme.values, "theme");
    $("#themeRawYaml").value = data.raw_yaml || "";
    $("#themeSourceText").textContent = `${data.base_path}  +  ${data.override_path}`;
    const themeWarnings = Array.isArray(data.warnings) ? data.warnings : [];
    const warningBox = $("#themeConfigWarnings");
    if (warningBox) {
      warningBox.classList.toggle("hidden", !themeWarnings.length);
      $("#themeConfigWarningText").textContent = themeWarnings.map((item) => item.message || item.path).join("；");
    }
    if (themeWarnings.length && !quiet) {
      toast("主题配置存在异常项", themeWarnings.map((item) => item.message || item.path).join("；"), "warning", 10000);
    }
    $("#menuComplexNotice").classList.toggle("hidden", state.theme.menuSimple);
    $("#socialComplexNotice").classList.toggle("hidden", state.theme.socialSimple);
    renderMenuItems();
    renderSocialItems();
    if (!state.theme.menuSimple || !state.theme.socialSimple) setConfigMode("theme", "raw");
    else setConfigMode("theme", "fields");
    $("#themeSaveHint").textContent = "配置已加载"; $("#themeSaveHint").className = "save-state";
    if (!quiet) toast("主题配置已刷新", "界面值来自主题默认 + 根目录覆盖，保存只写改动项。", "success", 2400);
  } catch (error) {
    state.theme.loaded = false;
    console.error("主题配置加载失败", error);
    $("#themeSaveHint").textContent = `加载失败：${error.message}`; $("#themeSaveHint").className = "save-state dirty";
    toast("无法加载主题配置", error.message, "error", 8000);
  }
}

function makeMenuInput(placeholder, value, className = "") {
  const input = document.createElement("input");
  input.type = "text";
  input.className = `menu-input ${className}`.trim();
  input.placeholder = placeholder;
  input.value = value || "";
  return input;
}

function renderMenuItems() {
  const container = $("#menuItems");
  container.replaceChildren();
  state.theme.menuItems.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "menu-item";
    const name = makeMenuInput("首页", item.name);
    const url = makeMenuInput("/", item.url, "mono");
    const icon = makeMenuInput("fas fa-home", item.icon, "mono");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-menu-button";
    remove.title = "删除菜单项";
    remove.innerHTML = '<svg><use href="#i-trash"></use></svg>';
    [name, url, icon].forEach((input, part) => input.addEventListener("input", () => {
      item[["name", "url", "icon"][part]] = input.value;
      state.theme.menuDirty = true;
      markDirty("theme");
    }));
    remove.addEventListener("click", () => {
      state.theme.menuItems.splice(index, 1);
      state.theme.menuDirty = true;
      markDirty("theme");
      renderMenuItems();
    });
    row.append(name, url, icon, remove);
    container.append(row);
  });
}

function renderSocialItems() {
  const container = $("#socialItems");
  container.replaceChildren();
  state.theme.socialItems.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "social-item";
    const icon = makeMenuInput("fab fa-github", item.icon, "mono");
    const url = makeMenuInput("https://...", item.url, "mono");
    const description = makeMenuInput("Github", item.description);
    const color = makeMenuInput("#24292e", item.color, "mono");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-menu-button";
    remove.title = "删除社交链接";
    remove.innerHTML = '<svg><use href="#i-trash"></use></svg>';
    [icon, url, description, color].forEach((input, part) => input.addEventListener("input", () => {
      item[["icon", "url", "description", "color"][part]] = input.value;
      state.theme.socialDirty = true;
      markDirty("theme");
    }));
    remove.addEventListener("click", () => {
      state.theme.socialItems.splice(index, 1);
      state.theme.socialDirty = true;
      markDirty("theme");
      renderSocialItems();
    });
    row.append(icon, url, description, color, remove);
    container.append(row);
  });
}

async function saveThemeConfig(event) {
  event.preventDefault();
  if (!state.theme.loaded) {
    toast("主题配置尚未加载", "请先修复页面顶部的加载错误，再重新保存。", "warning", 6500);
    return;
  }
  const button = $("#saveThemeButton");
  setButtonBusy(button, true, "正在保存...");
  try {
    let payload;
    if (state.theme.mode === "raw") {
      payload = { mode: "raw", raw_target: "override", raw_yaml: $("#themeRawYaml").value };
    } else {
      let payloadMenu;
      let payloadSocial;
      const fieldChanges = collectConfigChanges("theme", $("#themeFields"));
      if (state.theme.menuSimple && state.theme.menuDirty) {
        payloadMenu = state.theme.menuItems;
      }
      if (state.theme.socialSimple && state.theme.socialDirty) {
        payloadSocial = state.theme.socialItems;
      }
      if (!Object.keys(fieldChanges.changes).length && !fieldChanges.reset_paths.length && !state.theme.menuDirty && !state.theme.socialDirty) {
        toast("没有需要保存的修改", "表单值没有变化。", "info", 2200);
        return;
      }
      payload = { mode: "fields", changes: fieldChanges.changes, reset_paths: fieldChanges.reset_paths };
      if (typeof payloadMenu !== "undefined") payload.menu_items = payloadMenu;
      if (typeof payloadSocial !== "undefined") payload.social_items = payloadSocial;
    }
    await api("/api/theme-config", { method: "PUT", body: JSON.stringify(payload) });
    await loadThemeConfig({ quiet: true });
    $("#themeSaveHint").textContent = `已保存 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`; $("#themeSaveHint").className = "save-state saved";
    toast("主题配置已保存", "只写入了本次修改或重置的字段。", "success");
  } catch (error) {
    toast("保存失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function configImageValue(image) {
  return image?.relative_path ? `/img/${image.relative_path}` : "";
}

function configImagePreviewUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("/img/")) {
    const relative = text.slice(5);
    const image = state.configImage.images.find((item) => item.relative_path === relative);
    if (image) return image.url;
    return `/api/images/file?path=${encodeURIComponent(relative)}`;
  }
  return text;
}

function setConfigImagePreview(value) {
  const text = String(value || "").trim();
  const image = $("#configImagePreviewImage");
  const empty = $("#configImagePreviewEmpty");
  $("#configImageCurrentValue").textContent = text || "未设置";
  $("#configImageExternalHint").textContent = state.configImage.external ? "当前选择：直接使用外部 URL" : "";
  if (text) {
    image.src = configImagePreviewUrl(text);
    image.classList.remove("hidden");
    empty.classList.add("hidden");
  } else {
    image.removeAttribute("src");
    image.classList.add("hidden");
    empty.classList.remove("hidden");
  }
}

function createConfigImageItem(image, isNew) {
  const value = configImageValue(image);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cover-item ${isNew ? "new" : ""} ${state.configImage.selected === value ? "selected" : ""}`;
  button.title = image.relative_path;
  const thumbnail = document.createElement("img");
  thumbnail.loading = "lazy";
  thumbnail.src = image.url;
  thumbnail.alt = image.name;
  button.append(thumbnail);
  if (isNew) {
    const badge = document.createElement("span");
    badge.className = "cover-new-badge";
    badge.textContent = "新";
    button.append(badge);
  }
  if (state.configImage.selected === value) {
    const check = document.createElement("span");
    check.className = "cover-check";
    check.textContent = "✓";
    button.append(check);
  }
  button.addEventListener("click", () => {
    state.configImage.selected = state.configImage.selected === value ? "" : value;
    state.configImage.external = "";
    renderConfigImageLibrary();
    setConfigImagePreview(state.configImage.selected);
  });
  return button;
}

function renderConfigImageLibrary() {
  const container = $("#configImageLibrary");
  container.replaceChildren();
  if (!state.configImage.images.length) {
    const empty = document.createElement("div");
    empty.className = "config-image-empty";
    empty.textContent = "source/img 中还没有图片，可从 URL 添加或上传本地图片。";
    container.append(empty);
    $("#confirmConfigImageButton").disabled = !state.configImage.selected;
    return;
  }
  const images = [...state.configImage.images].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const newImages = images.filter((image) => state.configImage.newImages.has(image.relative_path));
  const normalImages = images.filter((image) => !state.configImage.newImages.has(image.relative_path));
  const appendGroup = (title, items, isNew) => {
    if (!items.length) return;
    const group = document.createElement("section");
    group.className = "cover-group";
    if (title) {
      const heading = document.createElement("strong");
      heading.className = "cover-group-title";
      heading.textContent = title;
      group.append(heading);
    }
    const grid = document.createElement("div");
    grid.className = "cover-group-grid";
    items.forEach((image) => grid.append(createConfigImageItem(image, isNew)));
    group.append(grid);
    container.append(group);
  };
  appendGroup("新加入", newImages, true);
  appendGroup("", normalImages, false);
  $("#confirmConfigImageButton").disabled = !state.configImage.selected;
}

async function openConfigImagePicker(kind, path) {
  const container = kind === "site" ? $("#siteFields") : $("#themeFields");
  const value = readConfigPathValue(container, path);
  const loadToken = state.configImage.loadToken + 1;
  state.configImage = {
    ...state.configImage,
    kind,
    path,
    selected: String(value || "").trim(),
    external: "",
    images: [],
    newImages: new Set(),
    loadToken,
  };
  $("#configImagePath").textContent = path;
  $("#configImageFileInput").value = "";
  setConfigImagePreview(state.configImage.selected);
  renderConfigImageLibrary();
  const dialog = $("#configImageDialog");
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api("/api/images?sort=name", { cache: "no-store" });
    if (state.configImage.loadToken !== loadToken) return;
    state.configImage.images = data.images || [];
    state.configImage.external = state.configImage.selected && !state.configImage.selected.startsWith("/img/") ? state.configImage.selected : "";
    setConfigImagePreview(state.configImage.selected);
    renderConfigImageLibrary();
  } catch (error) {
    closeConfigImageDialog();
    toast("无法打开图片库", error.message, "error");
  }
}

function closeConfigImageDialog() {
  state.configImage.loadToken += 1;
  state.configImage = { ...state.configImage, kind: "", path: "", selected: "", external: "", images: [], newImages: new Set() };
  const dialog = $("#configImageDialog");
  if (dialog?.open) dialog.close();
}

async function uploadConfigImage(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) toast("图片较大", "建议压缩后再使用，以免影响页面加载速度。", "warning", 6000);
  const button = $("#uploadConfigImageButton");
  setButtonBusy(button, true, "上传中...");
  try {
    const form = new FormData();
    form.append("scope", "config");
    form.append("file", file);
    const data = await api("/api/images/upload", { method: "POST", body: form });
    const image = data.image;
    state.configImage.images = [image, ...state.configImage.images.filter((item) => item.relative_path !== image.relative_path)];
    state.configImage.newImages.add(image.relative_path);
    state.configImage.selected = configImageValue(image);
    state.configImage.external = "";
    renderConfigImageLibrary();
    setConfigImagePreview(state.configImage.selected);
    toast("图片已上传", image.relative_path, "success");
  } catch (error) {
    toast("上传图片失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function addConfigImageFromUrl() {
  const url = window.prompt("请输入图片 URL：");
  if (!url) return;
  const button = $("#addConfigImageUrlButton");
  setButtonBusy(button, true, "添加中...");
  try {
    const data = await api("/api/images/from-url", {
      method: "POST",
      body: JSON.stringify({ url: url.trim(), scope: "config" }),
    });
    const image = data.image;
    state.configImage.images = [image, ...state.configImage.images.filter((item) => item.relative_path !== image.relative_path)];
    state.configImage.newImages.add(image.relative_path);
    state.configImage.selected = configImageValue(image);
    state.configImage.external = "";
    renderConfigImageLibrary();
    setConfigImagePreview(state.configImage.selected);
    toast("图片已加入图片库", image.relative_path, "success");
  } catch (error) {
    if (error.details?.download_failed && window.confirm(`${error.message}

是否直接将该 URL 写入配置？`)) {
      state.configImage.selected = url.trim();
      state.configImage.external = url.trim();
      renderConfigImageLibrary();
      setConfigImagePreview(state.configImage.selected);
    } else {
      toast("添加图片失败", error.message, "error");
    }
  } finally {
    setButtonBusy(button, false);
  }
}

function confirmConfigImage() {
  if (!state.configImage.selected || !state.configImage.path) return;
  const kind = state.configImage.kind;
  const path = state.configImage.path;
  const value = state.configImage.selected;
  const container = kind === "site" ? $("#siteFields") : $("#themeFields");
  setConfigPathValue(container, path, value);
  const control = $(`[data-path="${CSS.escape(path)}"]`, container);
  if (control) handleConfigControlChange(kind, control);
  closeConfigImageDialog();
  const kindLabel = kind === "theme" ? "主题" : "站点";
  toast("图片路径已填入", `${kindLabel}配置：${value}`, "success");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "未设置";
  const text = String(value).trim();
  const date = new Date(text.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return text;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function loadPosts(options = {}) {
  const { quiet = false } = options;
  try {
    const data = await api("/api/posts", { cache: "no-store" });
    state.posts = data.posts || [];
    renderPostTree();
    populatePostFolderSelect();
    renderPosts();
    const logAt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    (data.frontmatter_repaired || []).forEach((item) => appendLog({ time: logAt, level: "success", text: `已为 ${item.relative_path} 自动补全 front-matter` }));
    if (data.frontmatter_repaired?.length) toast("已自动补全 front-matter", `共处理 ${data.frontmatter_repaired.length} 篇文章。`, "success", 5000);
    (data.frontmatter_invalid || []).forEach((item) => appendLog({ time: logAt, level: "warning", text: `front-matter 未修改：${item.relative_path} · ${item.error}` }));
    (data.frontmatter_errors || []).forEach((item) => appendLog({ time: logAt, level: "error", text: `front-matter 自动补全失败：${item.relative_path} · ${item.error}` }));
    if (!quiet) toast("文章列表已刷新", "", "success", 2200);
  } catch (error) {
    if (!quiet) toast("无法加载文章", error.message, "error");
  }
}

function postFolderPaths() {
  const folders = new Set();
  state.posts.forEach((post) => {
    const parts = post.relative_path.split("/");
    parts.pop();
    let current = "";
    parts.forEach((part) => {
      current = current ? `${current}/${part}` : part;
      folders.add(current);
    });
  });
  return Array.from(folders).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function postCountInFolder(folder) {
  if (!folder) return state.posts.length;
  return state.posts.filter((post) => post.relative_path.startsWith(`${folder}/`)).length;
}

function renderPostTree() {
  const container = $("#postFolderTree");
  if (!container) return;
  container.replaceChildren();
  const folders = postFolderPaths();
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = `folder-node root-node ${state.postFolder === "" ? "active" : ""}`;
  rootButton.innerHTML = `<span class="folder-spacer"></span><span class="folder-icon"><svg><use href="#i-folder"></use></svg></span><span class="folder-name">全部文章</span><span class="folder-count">${state.posts.length}</span>`;
  rootButton.addEventListener("click", () => { state.postFolder = ""; renderPostTree(); renderPosts(); });
  container.append(rootButton);

  folders.forEach((folder) => {
    const parts = folder.split("/");
    const name = parts[parts.length - 1];
    const parent = parts.slice(0, -1).join("/");
    if (parent && !state.postFoldersExpanded.has(parent)) return;
    const hasChildren = folders.some((item) => item.startsWith(`${folder}/`));
    const row = document.createElement("div");
    row.className = "folder-row";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle";
    toggle.innerHTML = hasChildren ? '<svg><use href="#i-chevron"></use></svg>' : "";
    toggle.classList.toggle("expanded", state.postFoldersExpanded.has(folder));
    toggle.disabled = !hasChildren;
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.postFoldersExpanded.has(folder)) state.postFoldersExpanded.delete(folder);
      else state.postFoldersExpanded.add(folder);
      renderPostTree();
    });
    const node = document.createElement("button");
    node.type = "button";
    node.className = `folder-node ${state.postFolder === folder ? "active" : ""}`;
    node.style.paddingLeft = `${8 + parts.length * 14}px`;
    node.innerHTML = `<span class="folder-icon"><svg><use href="#i-folder"></use></svg></span><span class="folder-name">${escapeHtml(name)}</span><span class="folder-count">${postCountInFolder(folder)}</span>`;
    node.addEventListener("click", () => { state.postFolder = folder; renderPostTree(); renderPosts(); });
    row.append(toggle, node);
    container.append(row);
  });
}

function populatePostFolderSelect() {
  const select = $("#newPostFolder");
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  const root = document.createElement("option");
  root.value = "";
  root.textContent = "根目录 source/_posts";
  select.append(root);
  postFolderPaths().forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder;
    option.textContent = folder;
    select.append(option);
  });
  const custom = document.createElement("option");
  custom.value = "__new__";
  custom.textContent = "新建文件夹...";
  select.append(custom);
  if (current && Array.from(select.options).some((option) => option.value === current)) select.value = current;
  else if (state.postFolder && Array.from(select.options).some((option) => option.value === state.postFolder)) select.value = state.postFolder;
}
function updatePostSelectionUi() {
  const active = state.postSelection.active;
  const selectedCount = state.postSelection.selected.size;
  const button = $("#checkFrontmatterButton");
  const hint = $("#postSelectionHint");
  const clear = $("#clearPostSelectionButton");
  const card = $("#postListCard");
  const selectHead = $("#postSelectHead");
  const selectAll = $("#postSelectAll");
  if (!button) return;
  button.innerHTML = active
    ? '<svg><use href="#i-check"></use></svg><span>开始检查并修复</span>'
    : '<svg><use href="#i-check"></use></svg><span>检查并修复属性</span>';
  hint.textContent = `已选中 ${selectedCount} 篇`;
  hint.classList.toggle("hidden", !active);
  clear.classList.toggle("hidden", !active);
  clear.disabled = selectedCount === 0;
  card.classList.toggle("selection-mode", active);
  selectHead.classList.toggle("hidden", !active);
  const visible = state.postSelection.visiblePaths || [];
  selectAll.checked = visible.length > 0 && visible.every((path) => state.postSelection.selected.has(path));
  selectAll.indeterminate = visible.some((path) => state.postSelection.selected.has(path)) && !selectAll.checked;
}

function setPostSelectionMode(active) {
  state.postSelection.active = Boolean(active);
  state.postSelection.selected = new Set();
  renderPosts();
}

function createPostCheckbox(post) {
  const label = document.createElement("label");
  label.className = "post-checkbox";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.postSelection.selected.has(post.relative_path);
  checkbox.setAttribute("aria-label", `选择文章 ${post.title}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.postSelection.selected.add(post.relative_path);
    else state.postSelection.selected.delete(post.relative_path);
    updatePostSelectionUi();
  });
  label.append(checkbox);
  return label;
}

function clearPostSelection() {
  state.postSelection.selected = new Set();
  renderPosts();
}

async function runFrontmatterRepair() {
  let paths = Array.from(state.postSelection.selected);
  let checkAll = false;
  if (!paths.length) {
    const confirmed = window.confirm("没有选中任何文章，是否对全部文章进行检查并修复？");
    if (!confirmed) return;
    checkAll = true;
  }
  const uniquePaths = Array.from(new Set(paths));
  const button = $("#checkFrontmatterButton");
  setButtonBusy(button, true, "处理中...");
  try {
    const result = await api("/api/posts/frontmatter/repair", {
      method: "POST",
      body: JSON.stringify({ relative_paths: checkAll ? [] : uniquePaths }),
    });
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    (result.results || []).forEach((item) => {
      if (item.error) {
        appendLog({ time, level: "error", text: `属性检查失败：${item.relative_path} · ${item.error}` });
      } else if (item.changed) {
        appendLog({ time, level: "success", text: `已修复属性：${item.relative_path} · ${(item.changes || []).join("、")}` });
      } else {
        appendLog({ time, level: "muted", text: `属性完整，已跳过：${item.relative_path}` });
      }
    });
    toast("属性检查完成", `已检查 ${result.total || 0} 篇文章，修复了 ${result.changed || 0} 篇。`, result.errors ? "warning" : "success", 7000);
    await loadPosts({ quiet: true });
    setPostSelectionMode(false);
  } catch (error) {
    toast("属性检查失败", error.message, "error", 8000);
  } finally {
    setButtonBusy(button, false);
    updatePostSelectionUi();
  }
}

async function handleFrontmatterCheck() {
  if (!state.postSelection.active) {
    setPostSelectionMode(true);
    toast("请选择文章", "勾选需要检查的文章，然后再次点击“开始检查并修复”。", "info", 5500);
    return;
  }
  await runFrontmatterRepair();
}

function renderPosts() {
  const query = $("#postSearch").value.trim().toLowerCase();
  const folderFiltered = state.postFolder ? state.posts.filter((post) => post.relative_path.startsWith(`${state.postFolder}/`)) : state.posts;
  const filtered = folderFiltered.filter((post) => !query || post.title.toLowerCase().includes(query) || post.relative_path.toLowerCase().includes(query));
  state.postSelection.visiblePaths = filtered.map((post) => post.relative_path);
  const list = $("#postList");
  list.replaceChildren();
  filtered.forEach((post) => {
    const row = document.createElement("div");
    row.className = "post-row";
    const titleWrap = document.createElement("div");
    titleWrap.className = "post-title-wrap";
    const title = document.createElement("span");
    title.className = "post-title";
    title.textContent = post.title;
    const file = document.createElement("span");
    file.className = "post-file";
    file.textContent = post.relative_path;
    titleWrap.append(title, file);
    if (post.frontmatter_missing) {
      const badge = document.createElement("span");
      badge.className = "post-badge";
      badge.textContent = post.frontmatter_error ? "front-matter 无效" : "缺少 front-matter";
      badge.title = post.frontmatter_error || "点击“检查并修复属性”可补全";
      titleWrap.append(badge);
    }
    const date = document.createElement("span");
    date.className = "post-meta";
    date.textContent = formatDate(post.date || post.modified);
    const actions = document.createElement("div");
    actions.className = "post-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-button small";
    edit.title = "编辑文章";
    edit.setAttribute("aria-label", "编辑文章");
    edit.innerHTML = '<svg><use href="#i-edit"></use></svg>';
    edit.addEventListener("click", () => { if (state.postSelection.active) setPostSelectionMode(false); openPost(post.relative_path); });
    const properties = document.createElement("button");
    properties.type = "button";
    properties.className = "icon-button small";
    properties.title = "编辑属性";
    properties.setAttribute("aria-label", "编辑属性");
    properties.innerHTML = '<svg><use href="#i-file"></use></svg>';
    properties.addEventListener("click", () => { if (state.postSelection.active) setPostSelectionMode(false); openFrontmatterEditor(post.relative_path); });
    const cover = document.createElement("button");
    cover.type = "button";
    cover.className = "icon-button small";
    cover.title = "更换封面";
    cover.setAttribute("aria-label", "更换封面");
    cover.innerHTML = '<svg><use href="#i-image"></use></svg>';
    cover.addEventListener("click", () => { if (state.postSelection.active) setPostSelectionMode(false); openCoverDialog(post.relative_path); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button small";
    remove.title = "删除文章";
    remove.setAttribute("aria-label", "删除文章");
    remove.innerHTML = '<svg><use href="#i-trash"></use></svg>';
    remove.addEventListener("click", () => { if (state.postSelection.active) setPostSelectionMode(false); deletePost(post); });
    actions.append(edit, properties, cover, remove);
    if (state.postSelection.active) row.prepend(createPostCheckbox(post));
    row.append(titleWrap, date, actions);
    list.append(row);
  });
  $("#postCountLabel").textContent = `${filtered.length} 篇文章`;
  $("#postEmptyState").classList.toggle("hidden", filtered.length > 0);
  updatePostSelectionUi();
}

function coverValueForImage(image) {
  return `/img/${image.relative_path}`;
}

function resolveCoverImageUrl(value) {
  const cover = String(value || "").trim();
  if (!cover) return "";
  if (cover.startsWith("/img/")) {
    const relative = cover.slice(5);
    const image = state.images.find((item) => item.relative_path === relative);
    if (image) return image.url;
  }
  return cover;
}

function setCoverPreview(value) {
  const cover = String(value || "").trim();
  const image = $("#coverPreviewImage");
  const empty = $("#coverPreviewEmpty");
  $("#coverCurrentValue").textContent = cover || "未设置";
  $("#removeCoverButton").classList.toggle("hidden", !state.cover.currentCover);
  if (cover) {
    image.src = resolveCoverImageUrl(cover);
    image.classList.remove("hidden");
    empty.classList.add("hidden");
  } else {
    image.removeAttribute("src");
    image.classList.add("hidden");
    empty.classList.remove("hidden");
  }
  $("#coverExternalHint").textContent = state.cover.externalValue ? "当前选择：直接使用外部 URL" : "";
}

function addNewCoverImage(image) {
  if (!image || !image.relative_path) return;
  state.cover.loadToken += 1;
  state.images = [image, ...state.images.filter((item) => item.relative_path !== image.relative_path)];
  state.cover.newImages.add(image.relative_path);
  state.cover.selectedValue = coverValueForImage(image);
  state.cover.externalValue = "";
  renderCoverLibrary();
  setCoverPreview(state.cover.currentCover);
}

function createCoverItem(image, isNew) {
  const coverValue = coverValueForImage(image);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cover-item ${isNew ? "new" : ""} ${state.cover.selectedValue === coverValue ? "selected" : ""}`;
  button.title = image.relative_path;
  const thumbnail = document.createElement("img");
  thumbnail.loading = "lazy";
  thumbnail.src = image.url;
  thumbnail.alt = image.name;
  button.append(thumbnail);
  if (isNew) {
    const badge = document.createElement("span");
    badge.className = "cover-new-badge";
    badge.textContent = "新";
    button.append(badge);
  }
  if (state.cover.selectedValue === coverValue) {
    const check = document.createElement("span");
    check.className = "cover-check";
    check.textContent = "✓";
    button.append(check);
  }
  button.addEventListener("click", () => {
    state.cover.selectedValue = state.cover.selectedValue === coverValue ? "" : coverValue;
    state.cover.externalValue = "";
    renderCoverLibrary();
    setCoverPreview(state.cover.currentCover);
  });
  return button;
}

function renderCoverLibrary() {
  const container = $("#coverLibrary");
  container.replaceChildren();
  const images = [...state.images].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const newImages = images.filter((image) => state.cover.newImages.has(image.relative_path));
  const normalImages = images.filter((image) => !state.cover.newImages.has(image.relative_path));
  const appendGroup = (title, items, isNew) => {
    if (!items.length) return;
    const group = document.createElement("section");
    group.className = "cover-group";
    if (title) {
      const heading = document.createElement("strong");
      heading.className = "cover-group-title";
      heading.textContent = title;
      group.append(heading);
    }
    const grid = document.createElement("div");
    grid.className = "cover-group-grid";
    items.forEach((image) => grid.append(createCoverItem(image, isNew)));
    group.append(grid);
    container.append(group);
  };
  appendGroup("新加入", newImages, true);
  appendGroup("", normalImages, false);
  $("#confirmCoverButton").disabled = !state.cover.selectedValue;
}

async function openCoverDialog(relativePath) {
  const loadToken = state.cover.loadToken + 1;
  state.cover.loadToken = loadToken;
  state.cover.relativePath = relativePath;
  state.cover.newImages = new Set();
  state.cover.externalValue = "";
  state.cover.selectedValue = "";
  state.cover.currentCover = "";
  $("#coverPostPath").textContent = relativePath;
  $("#coverFileInput").value = "";
  renderCoverLibrary();
  setCoverPreview("");
  const dialog = $("#coverDialog");
  if (!dialog.open) dialog.showModal();
  try {
    const [frontmatter, images] = await Promise.all([
      api(`/api/posts/frontmatter?relative_path=${encodeURIComponent(relativePath)}`, { cache: "no-store" }),
      api("/api/images", { cache: "no-store" }),
    ]);
    if (state.cover.loadToken !== loadToken) return;
    state.images = images.images || [];
    state.cover.properties = frontmatter.properties || [];
    const coverProperty = state.cover.properties.find((item) => item.name === "cover");
    state.cover.currentCover = String(coverProperty?.value || "").trim();
    state.cover.selectedValue = state.cover.currentCover;
    state.cover.externalValue = state.cover.currentCover && !state.cover.currentCover.startsWith("/img/") ? state.cover.currentCover : "";
    setCoverPreview(state.cover.currentCover);
    renderCoverLibrary();
  } catch (error) {
    closeCoverDialog();
    toast("无法打开封面选择器", error.message, "error");
  }
}

async function persistArticleCover(value) {
  const data = await api(`/api/posts/frontmatter?relative_path=${encodeURIComponent(state.cover.relativePath)}`, { cache: "no-store" });
  if (data.invalid) throw new Error("front-matter 格式无效，无法修改 cover 字段。");
  const properties = (data.properties || []).filter((item) => item.name !== "cover");
  if (value) properties.push({ name: "cover", type: "text", value });
  await api("/api/posts/frontmatter", {
    method: "POST",
    body: JSON.stringify({ relative_path: state.cover.relativePath, properties }),
  });
}

async function uploadCoverImage(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    toast("图片较大", "建议压缩后再使用，以免影响页面加载速度。", "warning", 6000);
  }
  const button = $("#uploadCoverButton");
  setButtonBusy(button, true, "上传中...");
  try {
    const form = new FormData();
    form.append("file", file);
    const data = await api("/api/images/upload", { method: "POST", body: form });
    addNewCoverImage(data.image);
    toast("图片已上传", data.image.relative_path, "success");
  } catch (error) {
    toast("上传图片失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

const DROP_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif"]);
const DROP_COVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function fileExtension(name) {
  const index = String(name || "").lastIndexOf(".");
  return index < 0 ? "" : String(name).slice(index).toLowerCase();
}

// 上传前先在前端分流，避免把明显无效的文件发给后端
function partitionDroppedFiles(files, allowedExtensions) {
  const valid = [];
  const rejected = [];
  Array.from(files || []).forEach((file) => {
    const extension = fileExtension(file.name);
    if (!allowedExtensions.has(extension)) {
      rejected.push({ name: file.name, reason: `不支持的格式 ${extension || "（无扩展名）"}` });
    } else if (file.size === 0) {
      rejected.push({ name: file.name, reason: "文件内容为空" });
    } else {
      valid.push(file);
    }
  });
  return { valid, rejected };
}

async function uploadImageFiles(files, scope) {
  const form = new FormData();
  form.append("scope", scope);
  Array.from(files).forEach((file) => form.append("files", file, file.name));
  return api("/api/images/upload", { method: "POST", body: form });
}

function reportUploadOutcome(data, rejected, noun = "张图片") {
  const succeeded = data?.succeeded ?? (data?.image ? 1 : 0);
  const failed = [...(rejected || []), ...((data?.results || []).filter((item) => !item.ok))];
  if (!failed.length) {
    toast("上传完成", `已成功上传 ${succeeded} ${noun}。`, "success", 5000);
    return;
  }
  if (!succeeded) {
    toast("上传失败", failed.map((item) => `${item.name}：${item.reason || item.error}`).join("\n"), "error", 9000);
    return;
  }
  toast(
    "部分文件已上传",
    `${succeeded} 张成功，${failed.length} 张失败：` + failed.map((item) => `${item.name}（${item.reason || item.error}）`).join("；"),
    "warning",
    9000,
  );
}

function describeUploadError(error) {
  if (error?.details?.payload_too_large) return error.message;
  if (error?.details?.upload_failed) {
    const lines = (error.details.results || []).filter((item) => !item.ok)
      .map((item) => `${item.name}：${item.error}`);
    return lines.length ? `全部上传失败\n${lines.join("\n")}` : error.message;
  }
  return error?.message || "未知错误";
}

// 统一的拖拽落区：用计数器抵消子元素产生的 dragleave，避免高亮闪烁
function bindImageDropZone({ zone, overlay, progress, extensions, onFiles, noun }) {
  if (!zone) return;
  let depth = 0;

  const showOverlay = (visible) => {
    overlay?.classList.toggle("visible", visible);
    zone.classList.toggle("drop-active", visible);
    document.body.classList.toggle("drop-in-progress", visible);
  };
  const reset = () => {
    depth = 0;
    showOverlay(false);
  };
  const hasFiles = (event) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");

  zone.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    showOverlay(true);
  });
  zone.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    showOverlay(true);
  });
  zone.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) showOverlay(false);
  });
  // 拖拽被取消（按 Esc 或拖到别处松开）时不会触发 drop，需在此复位，否则高亮会卡住
  zone.addEventListener("dragend", reset);
  zone.addEventListener("drop", async (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    reset();
    const dropped = Array.from(event.dataTransfer.files || []);
    if (!dropped.length) return;
    const { valid, rejected } = partitionDroppedFiles(dropped, extensions);
    rejected.forEach((item) => appendLog({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), level: "warning", text: `已忽略非图片文件：${item.name}` }));
    if (!valid.length) {
      toast("没有可上传的图片", rejected.map((item) => `${item.name}（${item.reason}）`).join("\n"), "error", 9000);
      return;
    }
    progress?.classList.remove("hidden");
    try {
      const data = await onFiles(valid, rejected);
      reportUploadOutcome(data, rejected, noun);
    } catch (error) {
      const lines = [...rejected.map((item) => `${item.name}（${item.reason}）`), describeUploadError(error)];
      toast("上传失败", lines.join("\n"), "error", 10000);
    } finally {
      progress?.classList.add("hidden");
    }
  });
}

async function addCoverFromUrl() {
  const url = window.prompt("请输入图片 URL：");
  if (!url) return;
  const button = $("#addCoverUrlButton");
  setButtonBusy(button, true, "添加中...");
  try {
    const data = await api("/api/images/from-url", {
      method: "POST",
      body: JSON.stringify({ url: url.trim() }),
    });
    addNewCoverImage(data.image);
    toast("图片已加入图片库", data.image.relative_path, "success");
  } catch (error) {
    if (error.details?.download_failed && window.confirm(`${error.message}\n\n是否直接使用该 URL 作为封面？`)) {
      state.cover.externalValue = url.trim();
      state.cover.selectedValue = url.trim();
      renderCoverLibrary();
      setCoverPreview(state.cover.currentCover);
    } else {
      toast("添加图片失败", error.message, "error");
    }
  } finally {
    setButtonBusy(button, false);
  }
}

async function confirmCover() {
  if (!state.cover.selectedValue) {
    toast("请选择封面图片", "点击图片库中的图片，或使用 URL 添加。", "warning");
    return;
  }
  const button = $("#confirmCoverButton");
  const selectedValue = state.cover.selectedValue;
  setButtonBusy(button, true, "保存中...");
  try {
    await persistArticleCover(selectedValue);
    closeCoverDialog();
    await loadPosts({ quiet: true });
    await loadImages({ quiet: true });
    toast("封面已更新", selectedValue, "success");
  } catch (error) {
    toast("保存封面失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function removeCover() {
  if (!state.cover.currentCover) return;
  if (!window.confirm("确定移除当前文章的 cover 字段吗？图片文件不会被删除。")) return;
  const button = $("#removeCoverButton");
  setButtonBusy(button, true, "移除中...");
  try {
    await persistArticleCover(null);
    state.cover.currentCover = "";
    state.cover.selectedValue = "";
    state.cover.externalValue = "";
    renderCoverLibrary();
    setCoverPreview("");
    await loadPosts({ quiet: true });
    toast("封面已移除", "图片文件未删除。", "success");
  } catch (error) {
    toast("移除封面失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function closeCoverDialog() {
  state.cover.loadToken += 1;
  state.cover.relativePath = "";
  state.cover.selectedValue = "";
  state.cover.externalValue = "";
  state.cover.newImages = new Set();
  $("#coverFileInput").value = "";
  $("#coverDialog").close();
}

const FRONTMATTER_TYPES = [
  ["text", "文本"],
  ["date", "日期"],
  ["array", "数组"],
  ["number", "数字"],
  ["boolean", "布尔"],
  ["yaml", "YAML 对象"],
];

function frontmatterTypeLabel(type) {
  return (FRONTMATTER_TYPES.find((item) => item[0] === type) || FRONTMATTER_TYPES[0])[1];
}

function toDateInputValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace(/\//g, "-").replace(" ", "T").replace(/Z$/i, "");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return text;
  const day = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return match[4] ? `${day}T${match[4].padStart(2, "0")}:${match[5]}:${match[6] || "00"}` : day;
}

function frontmatterDisplayValue(property) {
  const type = property.type || "text";
  const value = property.value;
  if (type === "array") return Array.isArray(value) ? value.join(", ") : String(value || "");
  if (type === "yaml") return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (type === "boolean") return value === true || value === "true" ? "true" : "false";
  if (type === "date") return toDateInputValue(value);
  return value === null || value === undefined ? "" : String(value);
}

function createFrontmatterValueControl(property) {
  const type = property.type || "text";
  let control;
  if (type === "array") {
    control = document.createElement("input");
    control.type = "text";
    control.placeholder = "多个值用逗号分隔";
  } else if (type === "yaml") {
    control = document.createElement("textarea");
    control.rows = 4;
    control.placeholder = "YAML 内容";
  } else if (type === "boolean") {
    control = document.createElement("select");
    [["true", "true"], ["false", "false"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      control.append(option);
    });
  } else if (type === "number") {
    control = document.createElement("input");
    control.type = "number";
    control.step = "any";
  } else if (type === "date") {
    control = document.createElement("input");
    control.type = /T\d/.test(toDateInputValue(property.value)) ? "datetime-local" : "date";
    control.step = "1";
  } else {
    control = document.createElement("input");
    control.type = "text";
  }
  control.dataset.field = "value";
  control.dataset.originalValue = property.value === null || property.value === undefined ? "" : String(property.value);
  control.dataset.originalDateValue = type === "date" ? toDateInputValue(property.value) : "";
  control.value = frontmatterDisplayValue(property);
  return control;
}

function renderFrontmatterProperties() {
  const container = $("#frontmatterProperties");
  container.replaceChildren();
  if (!state.frontmatter.invalid && !state.frontmatter.properties.length) {
    state.frontmatter.properties.push({ name: "", type: "text", value: "" });
  }
  state.frontmatter.properties.forEach((property, index) => {
    const row = document.createElement("div");
    row.className = "frontmatter-property-row";
    row.dataset.index = String(index);
    const name = document.createElement("input");
    name.dataset.field = "name";
    name.placeholder = "属性名";
    name.value = property.name || "";
    const type = document.createElement("select");
    type.dataset.field = "type";
    FRONTMATTER_TYPES.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      type.append(option);
    });
    type.value = property.type || "text";
    const valueCell = document.createElement("div");
    valueCell.className = "fm-value-field";
    let valueControl = createFrontmatterValueControl(property);
    valueCell.append(valueControl);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-property-button";
    remove.title = "删除该属性";
    remove.innerHTML = '<svg><use href="#i-trash"></use></svg>';
    name.addEventListener("input", () => { property.name = name.value; });
    type.addEventListener("change", () => {
      property.type = type.value;
      property.value = valueControl.value;
      valueControl = createFrontmatterValueControl(property);
      valueCell.replaceChildren(valueControl);
    });
    remove.addEventListener("click", () => {
      state.frontmatter.properties.splice(index, 1);
      renderFrontmatterProperties();
    });
    row.append(name, type, valueCell, remove);
    container.append(row);
  });
}

function collectFrontmatterProperties() {
  const properties = [];
  $$(".frontmatter-property-row").forEach((row) => {
    const name = $('[data-field="name"]', row).value.trim();
    const type = $('[data-field="type"]', row).value;
    const raw = $('[data-field="value"]', row).value;
    if (!name) return;
    let value = raw;
    if (type === "array") {
      value = raw.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
    } else if (type === "boolean") {
      value = raw === "true";
    } else if (type === "number") {
      value = raw.trim();
    } else if (type === "date") {
      const control = $('[data-field="value"]', row);
      const selectedDate = raw.trim().replace("T", " ");
      const originalValue = String(control.dataset.originalValue || "").trim().replace("T", " ");
      const originalDate = String(control.dataset.originalDateValue || "").trim().replace("T", " ");
      if (selectedDate && originalDate && selectedDate === originalDate && originalValue) {
        value = originalValue;
      } else {
        const time = originalValue.match(/[ T](\d{1,2}:\d{2}(?::\d{2})?)/);
        value = selectedDate && time && !/[ T]\d{1,2}:/.test(selectedDate) ? `${selectedDate} ${time[1]}` : selectedDate;
      }
    } else {
      value = raw;
    }
    properties.push({ name, type, value });
  });
  return properties;
}

function renderFrontmatterPostList() {
  const container = $("#frontmatterPostList");
  const query = $("#frontmatterSearch").value.trim().toLowerCase();
  container.replaceChildren();
  state.posts
    .filter((post) => !query || post.title.toLowerCase().includes(query) || post.relative_path.toLowerCase().includes(query))
    .forEach((post) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `frontmatter-post-item ${state.frontmatter.selectedPath === post.relative_path ? "active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = post.title;
      const path = document.createElement("small");
      path.textContent = post.relative_path;
      if (post.frontmatter_missing) {
        const badge = document.createElement("span");
        badge.className = "post-badge";
        badge.textContent = post.frontmatter_error ? "front-matter 无效" : "缺少 front-matter";
        button.append(title, path, badge);
      } else {
        button.append(title, path);
      }
      button.addEventListener("click", () => selectFrontmatterPost(post.relative_path));
      container.append(button);
    });
}

async function selectFrontmatterPost(relativePath) {
  // loadToken 防止"先点 A 再点 B"时 A 的响应后到、把 A 的属性覆盖到 B 的文章上：
  // 保存用的是 state.frontmatter.selectedPath，属性却来自最后一次到货的响应。
  const loadToken = state.frontmatter.loadToken + 1;
  state.frontmatter.loadToken = loadToken;
  state.frontmatter.selectedPath = relativePath;
  state.frontmatter.loading = true;
  renderFrontmatterPostList();
  $("#frontmatterPath").textContent = relativePath;
  $("#frontmatterEmpty").classList.add("hidden");
  $("#frontmatterEditorContent").classList.remove("hidden");
  $("#frontmatterSaveHint").textContent = "正在加载...";
  try {
    const data = await api(`/api/posts/frontmatter?relative_path=${encodeURIComponent(relativePath)}`, { cache: "no-store" });
    if (state.frontmatter.loadToken !== loadToken) return; // 已被更新的选择取代，丢弃过期响应
    state.frontmatter.properties = Array.isArray(data.properties) ? data.properties : [];
    state.frontmatter.invalid = Boolean(data.invalid);
    const warning = $("#frontmatterWarning");
    warning.classList.toggle("hidden", !data.invalid && !data.missing);
    $("#frontmatterWarningText").textContent = data.message || (data.invalid ? "front-matter 格式无效。" : "保存时会创建 front-matter。");
    $("#saveFrontmatterButton").disabled = Boolean(data.invalid);
    renderFrontmatterProperties();
    $("#frontmatterSaveHint").textContent = data.invalid ? "front-matter 无效，暂不能保存。" : "已加载";
  } catch (error) {
    if (state.frontmatter.loadToken !== loadToken) return;
    state.frontmatter.properties = [];
    state.frontmatter.invalid = true;
    $("#saveFrontmatterButton").disabled = true;
    renderFrontmatterProperties();
    $("#frontmatterSaveHint").textContent = error.message;
    toast("无法读取 front-matter", error.message, "error");
  } finally {
    if (state.frontmatter.loadToken === loadToken) state.frontmatter.loading = false;
  }
}

async function openFrontmatterEditor(relativePath = "") {
  await loadPosts({ quiet: true });
  if (!state.posts.length) {
    toast("没有可编辑的文章", "请先创建文章或刷新文章列表。", "warning");
    return;
  }
  const dialog = $("#frontmatterDialog");
  if (!dialog.open) dialog.showModal();
  $("#frontmatterSearch").value = "";
  renderFrontmatterPostList();
  const selected = relativePath || state.frontmatter.selectedPath || state.posts[0].relative_path;
  await selectFrontmatterPost(selected);
}

function closeFrontmatterEditor() {
  $("#frontmatterDialog").close();
}

async function saveFrontmatter() {
  const targetPath = state.frontmatter.selectedPath;
  if (!targetPath) return;
  if (state.frontmatter.invalid) {
    toast("无法保存", "当前 front-matter YAML 格式无效，请先在 Markdown 编辑器中修复。", "error", 7000);
    return;
  }
  // 属性必须与目标文章一致：若选择已切换（或仍在加载），说明表单里的属性
  // 属于另一篇文章，直接放弃而不是把它写进 targetPath。
  if (state.frontmatter.loading || state.frontmatter.selectedPath !== targetPath) {
    toast("请先等待属性加载完成", "文章已切换，请重新确认属性后再保存。", "warning", 6000);
    return;
  }
  const properties = collectFrontmatterProperties();
  const names = properties.map((item) => item.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    toast("属性名重复", `请修改重复的属性：${duplicate}`, "error");
    return;
  }
  const button = $("#saveFrontmatterButton");
  setButtonBusy(button, true, "保存中...");
  try {
    const data = await api("/api/posts/frontmatter", {
      method: "POST",
      body: JSON.stringify({ relative_path: targetPath, properties }),
    });
    state.frontmatter.properties = data.properties || [];
    state.frontmatter.invalid = false;
    $("#frontmatterWarning").classList.add("hidden");
    $("#saveFrontmatterButton").disabled = false;
    renderFrontmatterProperties();
    $("#frontmatterSaveHint").textContent = "已保存";
    toast("文章属性已保存", targetPath, "success");
    await loadPosts({ quiet: true });
    renderFrontmatterPostList();
  } catch (error) {
    toast("保存 front-matter 失败", `${error.message} 请确认文件没有被其他程序占用。`, "error", 9000);
  } finally {
    setButtonBusy(button, false);
  }
}

function addFrontmatterProperty() {
  state.frontmatter.properties.push({ name: "", type: "text", value: "" });
  renderFrontmatterProperties();
  const rows = $$(".frontmatter-property-row");
  const last = rows[rows.length - 1];
  if (last) $('[data-field="name"]', last).focus();
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlightMarkdown(source) {
  let html = escapeHtml(source);
  html = html.replace(/^---\s*$/gm, '<span class="md-token-quote">---</span>');
  html = html.replace(/^(#{1,6}\s.*)$/gm, '<span class="md-token-heading">$1</span>');
  html = html.replace(/^\s*([-*+]|\d+\.)\s+/gm, '<span class="md-token-list">$&</span>');
  html = html.replace(/^(\s*>.*)$/gm, '<span class="md-token-quote">$1</span>');
  html = html.replace(/`([^`]+)`/g, '<span class="md-token-code">`$1`</span>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-token-strong">**$1**</span>');
  html = html.replace(/\*([^*\n]+)\*/g, '<span class="md-token-em">*$1*</span>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-token-link">[$1]($2)</span>');
  return html;
}

// 语法高亮是整篇文档的 8 次正则 + 一次大段 innerHTML 重建。超大文档下这会
// 让每次按键都卡顿数百毫秒，因此超过阈值就退化成"仅转义"的纯文本高亮层。
const MARKDOWN_HIGHLIGHT_MAX_CHARS = 300000;
const MARKDOWN_HIGHLIGHT_MAX_LINES = 20000;

function applyMarkdownHighlight(text) {
  const tooLarge = text.length > MARKDOWN_HIGHLIGHT_MAX_CHARS;
  const highlight = $("#markdownHighlight");
  highlight.innerHTML = tooLarge ? escapeHtml(text) : highlightMarkdown(text);
  highlight.dataset.plain = tooLarge ? "1" : "";
  const meta = $("#markdownPreviewMeta");
  if (tooLarge && meta) meta.textContent = "文档较大，已关闭语法着色以保证输入流畅";
}

function updateMarkdownLineNumbers() {
  const source = $("#markdownSource");
  // split 只为拿行数，超大文档用换行计数避免额外分配一份全文数组
  const count = Math.max(1, (source.value.match(/\n/g) || []).length + 1);
  const numbers = $("#markdownLineNumbers");
  if (numbers.dataset.lineCount === String(count)) return;
  numbers.textContent = Array.from({ length: count }, (_item, index) => index + 1).join("\n");
  numbers.dataset.lineCount = String(count);
}

function syncMarkdownScroll() {
  const source = $("#markdownSource");
  $("#markdownHighlight").scrollTop = source.scrollTop;
  $("#markdownHighlight").scrollLeft = source.scrollLeft;
  $("#markdownLineNumbers").scrollTop = source.scrollTop;
}

// 高亮层刷新只在同一帧内合并一次：IME 合成期间也要刷新，否则 textarea 的文字
// 是透明的（颜色由高亮层提供），用户会看不到正在输入的拼音/候选内容。
function scheduleMarkdownHighlight() {
  if (state.editor.highlightPending) return;
  state.editor.highlightPending = true;
  requestAnimationFrame(() => {
    state.editor.highlightPending = false;
    if (!state.editor.relativePath) return;
    const source = $("#markdownSource");
    const hasFocus = document.activeElement === source;
    const selectionStart = hasFocus ? source.selectionStart : null;
    const selectionEnd = hasFocus ? source.selectionEnd : null;
    applyMarkdownHighlight(state.editor.content);
    updateMarkdownLineNumbers();
    if (hasFocus && document.activeElement === source
        && (source.selectionStart !== selectionStart || source.selectionEnd !== selectionEnd)) {
      source.setSelectionRange(selectionStart, selectionEnd);
    }
    syncMarkdownScroll();
  });
}

async function openPost(relativePath) {
  try {
    const data = await api(`/api/posts/content?relative_path=${encodeURIComponent(relativePath)}`, { cache: "no-store" });
    state.editor.relativePath = data.relative_path;
    state.editor.content = data.content;
    state.editor.original = data.content;
    state.editor.dirty = false;
    $("#markdownTitle").textContent = relativePath.split("/").pop() || "文章编辑";
    $("#markdownPath").textContent = data.relative_path;
    $("#markdownSource").value = data.content;
    applyMarkdownHighlight(data.content);
    $("#markdownStatus").textContent = "已加载";
    $("#markdownStatus").className = "markdown-status";
    updateMarkdownLineNumbers();
    syncMarkdownScroll();
    renderMarkdownPreview();
    $("#markdownDialog").showModal();
    $("#markdownSource").focus();
  } catch (error) {
    toast("无法打开文章", error.message, "error");
  }
}

async function saveMarkdownPost() {
  if (!state.editor.relativePath) return;
  const button = $("#saveMarkdownButton");
  setButtonBusy(button, true, "保存中...");
  try {
    await api("/api/posts/content", {
      method: "PUT",
      body: JSON.stringify({ relative_path: state.editor.relativePath, content: $("#markdownSource").value }),
    });
    state.editor.original = state.editor.content;
    state.editor.dirty = false;
    $("#markdownStatus").textContent = "已保存";
    $("#markdownStatus").className = "markdown-status saved";
    toast("文章已保存", "Front Matter 和正文已写回原文件。", "success");
    await loadPosts({ quiet: true });
  } catch (error) {
    toast("保存文章失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function closeMarkdownEditor() {
  if (state.editor.dirty && !window.confirm("文章有未保存修改，确定关闭吗？")) return;
  // 关闭时复位编辑状态，避免合成中途关闭导致 composing 永久为真
  state.editor.composing = false;
  clearTimeout(state.editor.renderTimer);
  $("#markdownDialog").close();
}

// 行内公式要求 $ 内侧紧贴非空白字符，且开头不能是数字，避免把
// "$5 and $10"、"$50$" 这类金额当成公式；\\[\s\S] 让公式内的 \$ 不被当作结束符。
const INLINE_MATH = String.raw`(^|[^$\\])\$(?![\s$0-9])((?:\\[\s\S]|[^$\n\\])*[^\s$\\])\$(?!\$)`;
const MATH_PATTERN = new RegExp(
  String.raw`\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|` + INLINE_MATH,
  "g",
);
// 围栏代码块与行内代码：其中的 $ 不应被当作公式（与 Hexo 渲染行为保持一致）
const CODE_REGION_PATTERN = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

function stripFrontMatter(source) {
  return source.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

// 先把代码区域抽成占位符，后续的公式识别就不会误伤代码里的 $
function protectCodeRegions(source) {
  const codeTokens = [];
  const text = source.replace(CODE_REGION_PATTERN, (match) => {
    const index = codeTokens.push(match) - 1;
    return `BM_CODE_${index}_TOKEN`;
  });
  return { text, codeTokens };
}

function restoreCodeTokens(html, codeTokens) {
  return html.replace(/BM_CODE_(\d+)_TOKEN/g, (match, rawIndex) => {
    const value = codeTokens[Number(rawIndex)];
    return value === undefined ? match : value;
  });
}

function protectMath(source) {
  const maths = [];
  const text = source.replace(
    MATH_PATTERN,
    (match, displayDollar, displayBracket, inlineParen, prefix, inlineDollar) => {
      let tex = "";
      let display = false;
      if (displayDollar !== undefined) { tex = displayDollar; display = true; }
      else if (displayBracket !== undefined) { tex = displayBracket; display = true; }
      else if (inlineParen !== undefined) { tex = inlineParen; display = false; }
      else { tex = inlineDollar; display = false; }
      const index = maths.push({ tex: tex.trim(), display }) - 1;
      return `${prefix || ""}BM_MATH_${index}_TOKEN`;
    },
  );
  return { text, maths };
}

function basicMarkdown(source) {
  const lines = escapeHtml(source).split(/\r?\n/);
  const output = [];
  let inCode = false;
  let inList = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { output.push(`${line}\n`); continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inList) { output.push("<ul>"); inList = true; }
      output.push(`<li>${line.replace(/^\s*[-*+]\s+/, "")}</li>`);
      continue;
    }
    if (inList) { output.push("</ul>"); inList = false; }
    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      output.push(`<h${level}>${line.replace(/^#{1,6}\s+/, "")}</h${level}>`);
    } else if (/^\s*>/.test(line)) {
      output.push(`<blockquote>${line.replace(/^\s*>\s?/, "")}</blockquote>`);
    } else if (line.trim() === "") {
      output.push("");
    } else {
      output.push(`<p>${line}</p>`);
    }
  }
  if (inList) output.push("</ul>");
  if (inCode) output.push("</code></pre>");
  return output.join("\n");
}

function mathJaxHtml(html, maths) {
  let result = html;
  maths.forEach((math, index) => {
    const delimiters = math.display ? [`\\[`, `\\]`] : [`\\(`, `\\)`];
    result = result.replace(`BM_MATH_${index}_TOKEN`, `${delimiters[0]}${escapeHtml(math.tex)}${delimiters[1]}`);
  });
  return result;
}

let mathJaxPromise = null;
function loadMathJax() {
  if (window.MathJax?.typesetPromise) return window.MathJax.typesetPromise();
  if (mathJaxPromise) return mathJaxPromise;
  window.MathJax = {
    loader: { load: ["[tex]/ams", "[tex]/physics", "[tex]/mhchem"] },
    tex: {
      packages: { "[+]": ["ams", "physics", "mhchem"] },
      inlineMath: [["\\(", "\\)"]],
      displayMath: [["\\[", "\\]"]],
      processEscapes: true
    },
    options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"] }
  };
  mathJaxPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js";
    script.onload = () => resolve(window.MathJax.typesetPromise());
    script.onerror = () => { mathJaxPromise = null; script.remove(); reject(new Error("MathJax 加载失败")); };
    document.head.append(script);
  });
  return mathJaxPromise;
}

async function renderWithMathJax(html, maths) {
  const preview = $("#markdownPreview");
  preview.innerHTML = mathJaxHtml(html, maths);
  try {
    await loadMathJax();
    await window.MathJax.typesetPromise([preview]);
    $("#markdownPreviewMeta").textContent = "MathJax 回退预览";
  } catch (_error) {
    $("#markdownPreviewMeta").textContent = "公式引擎不可用";
  }
}

function renderMarkdownPreview() {
  // IME 合成过程中不重排预览：高亮层已由 refreshMarkdownEditorView 更新，
  // 足够让用户看到拼音/候选字，同时避免打断连打体验。
  if (state.editor.composing) {
    scheduleMarkdownPreview();
    return;
  }
  const preview = $("#markdownPreview");
  const source = stripFrontMatter($("#markdownSource").value);
  if (source.length > 200000) {
    preview.textContent = source;
    $("#markdownPreviewMeta").textContent = "文档较大，显示文本预览以保持编辑流畅";
    return;
  }
  const codeProtected = protectCodeRegions(source);
  const protectedSource = protectMath(codeProtected.text);
  state.editor.codeTokens = codeProtected.codeTokens;
  let html;
  try {
    html = markdownRenderer
      ? markdownRenderer.render(restoreCodeTokens(protectedSource.text, codeProtected.codeTokens))
      : basicMarkdown(restoreCodeTokens(protectedSource.text, codeProtected.codeTokens));
  } catch (_error) {
    html = basicMarkdown(restoreCodeTokens(protectedSource.text, codeProtected.codeTokens));
  }
  html = html.replace(/BM_MATH_(\d+)_TOKEN/g, (match, rawIndex) => {
    const index = Number(rawIndex);
    const math = protectedSource.maths[index];
    return math ? `<span class="math-render" data-math-index="${index}" data-display="${math.display ? "1" : "0"}"></span>` : match;
  });
  if (window.DOMPurify) html = window.DOMPurify.sanitize(html, { ADD_ATTR: ["data-math-index", "data-display"] });
  preview.innerHTML = html;
  const nodes = Array.from(preview.querySelectorAll(".math-render"));
  if (!nodes.length) {
    $("#markdownPreviewMeta").textContent = "Markdown 预览";
    return;
  }
  if (!window.katex) {
    renderWithMathJax(html, protectedSource.maths);
    return;
  }
  try {
    nodes.forEach((node) => {
      const math = protectedSource.maths[Number(node.dataset.mathIndex)];
      window.katex.render(math.tex, node, { displayMode: Boolean(math.display), throwOnError: true, strict: false, trust: katexTrustPolicy });
    });
    $("#markdownPreviewMeta").textContent = "KaTeX 实时预览";
  } catch (_error) {
    renderWithMathJax(html, protectedSource.maths);
  }
}

function scheduleMarkdownPreview() {
  clearTimeout(state.editor.renderTimer);
  if (state.editor.composing) return;
  state.editor.renderTimer = setTimeout(renderMarkdownPreview, 360);
}

function refreshMarkdownEditorView() {
  const source = $("#markdownSource");
  state.editor.content = source.value;
  state.editor.dirty = state.editor.content !== state.editor.original;
  $("#markdownStatus").textContent = state.editor.dirty ? "未保存" : "已加载";
  $("#markdownStatus").className = `markdown-status ${state.editor.dirty ? "dirty" : ""}`;
  // 高亮层必须刷新（含 IME 合成期间），否则透明 textarea 上的文字不可见；
  // 预览渲染则继续延后，避免在合成期间被重排打断。
  scheduleMarkdownHighlight();
  if (state.editor.composing) return;
  scheduleMarkdownPreview();
}

function wrapMarkdownSelection(prefix, suffix = prefix) {
  const input = $("#markdownSource");
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const selected = input.value.slice(start, end);
  input.setRangeText(`${prefix}${selected}${suffix}`, start, end, "end");
  if (start === end) input.setSelectionRange(start + prefix.length, start + prefix.length);
  else input.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function deletePost(post) {
  if (!window.confirm(`确定删除“${post.title}”吗？文章会移动到博客根目录的 .blogmanager-trash，而不是永久删除。`)) return;
  try {
    const data = await api("/api/posts", { method: "DELETE", body: JSON.stringify({ relative_path: post.relative_path }) });
    toast("文章已移入回收目录", data.moved_to || post.relative_path, "success");
    const cleanup = data.trash_cleanup;
    if (cleanup && cleanup.removed) {
      toast("回收站已自动清理", `清理 ${cleanup.removed} 个过期或超量文件，剩余 ${formatBytes(cleanup.bytes_after || 0)}。`, "info", 6000);
    }
    await loadPosts({ quiet: true });
  } catch (error) {
    toast("删除失败", error.message, "error");
  }
}

async function cleanPostTrash() {
  const button = $("#cleanTrashButton");
  try {
    const status = await api("/api/posts/trash", { cache: "no-store" });
    if (!status.exists || !status.count) {
      toast("回收站是空的", "没有需要清理的备份文件。", "info");
      return;
    }
    const size = formatBytes(status.bytes || 0);
    if (!window.confirm(`确定清空回收站吗？将删除 ${status.count} 个文件（${size}），此操作不可恢复。`)) return;
    setButtonBusy(button, true, "清理中...");
    const result = await api("/api/posts/trash/cleanup", { method: "POST", body: "{}" });
    const cleanup = result.cleanup || {};
    const migration = result.migration || {};
    const parts = [`删除 ${cleanup.removed || 0} 个文件`];
    if (cleanup.failed) parts.push(`${cleanup.failed} 个失败`);
    if (migration.moved) parts.push(`迁移旧回收站 ${migration.moved} 个文件`);
    toast("回收站已清理", `${parts.join("，")}。保留上限 ${status.retention_days} 天 / ${formatBytes(status.max_bytes || 0)}。`, cleanup.failed ? "warning" : "success", 7000);
  } catch (error) {
    toast("无法清理回收站", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function closeNewPostDialog() {
  $("#newPostDialog").close();
  $("#newPostForm").reset();
  $("#newPostFolderCustomField").classList.add("hidden");
}

async function createPost(event) {
  event.preventDefault();
  const title = $("#newPostTitle").value.trim();
  if (!title) {
    toast("标题不能为空", "请填写文章标题后再创建。", "warning");
    $("#newPostTitle").focus();
    return;
  }
  const button = $("#confirmNewPostButton");
  setButtonBusy(button, true, "创建中...");
  try {
    const split = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
    await api("/api/posts", {
      method: "POST",
      body: JSON.stringify({
        title,
        filename: $("#newPostFilename").value,
        folder: $("#newPostFolder").value === "__new__" ? $("#newPostFolderCustom").value : $("#newPostFolder").value,
        categories: split($("#newPostCategories").value),
        tags: split($("#newPostTags").value),
      }),
    });
    closeNewPostDialog();
    toast("文章已创建", "正在刷新文章列表。", "success");
    await loadPosts({ quiet: true });
  } catch (error) {
    toast("新建文章失败", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadImages(options = {}) {
  const { quiet = false } = options;
  try {
    const data = await api("/api/images", { cache: "no-store" });
    state.images = data.images || [];
    renderImages();
    if (!quiet) toast("图片列表已刷新", "", "success", 2200);
  } catch (error) {
    if (!quiet) toast("无法加载图片", error.message, "error");
  }
}

async function uploadImagesFromPicker(fileList) {
  const button = $("#uploadImagesButton");
  const { valid, rejected } = partitionDroppedFiles(fileList, DROP_IMAGE_EXTENSIONS);
  rejected.forEach((item) => appendLog({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), level: "warning", text: `已忽略非图片文件：${item.name}` }));
  if (!valid.length) {
    toast("没有可上传的图片", rejected.map((item) => `${item.name}（${item.reason}）`).join("\n"), "error", 9000);
    return;
  }
  setButtonBusy(button, true, "上传中...");
  try {
    const data = await uploadImageFiles(valid, "all");
    reportUploadOutcome(data, rejected);
    await loadImages({ quiet: true });
  } catch (error) {
    toast("上传失败", describeUploadError(error), "error", 9000);
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleImageDrop(files) {
  const data = await uploadImageFiles(files, "all");
  // 新图片排在最前：列表接口按 modified 倒序返回
  await loadImages({ quiet: true });
  return data;
}

async function handleCoverDrop(files) {
  const selectedValue = state.cover.selectedValue;
  const relativePath = state.cover.relativePath;
  const data = await uploadImageFiles(files, "cover");
  const images = data.images || [];
  images.forEach((image) => {
    state.images = [image, ...state.images.filter((item) => item.relative_path !== image.relative_path)];
    if (state.cover.relativePath === relativePath) state.cover.newImages.add(image.relative_path);
  });
  // Uploading is independent of selecting: preserve the choice made before or
  // during the upload, and do not mutate a different article's dialog.
  if (state.cover.relativePath === relativePath && $("#coverDialog").open) {
    if (!selectedValue && !state.cover.selectedValue && images.length) {
      state.cover.selectedValue = coverValueForImage(images[images.length - 1]);
      setCoverPreview(state.cover.selectedValue);
    }
    renderCoverLibrary();
  }
  return data;
}

function renderImages() {
  const query = $("#imageSearch").value.trim().toLowerCase();
  const filtered = state.images.filter((image) => !query || image.name.toLowerCase().includes(query) || image.relative_path.toLowerCase().includes(query));
  const grid = $("#imageGrid");
  grid.replaceChildren();
  filtered.forEach((image) => {
    const card = document.createElement("article");
    card.className = "image-card";
    const thumbnail = document.createElement("img");
    thumbnail.className = "image-thumb";
    thumbnail.loading = "lazy";
    thumbnail.src = image.url;
    thumbnail.alt = image.name;
    thumbnail.addEventListener("click", () => showImagePreview(image));
    const info = document.createElement("div");
    info.className = "image-info";
    const name = document.createElement("span");
    name.className = "image-name";
    name.textContent = image.name;
    const path = document.createElement("span");
    path.className = "image-path";
    path.textContent = image.relative_path;
    const footer = document.createElement("div");
    footer.className = "image-footer";
    const size = document.createElement("span");
    size.className = "image-size";
    size.textContent = formatBytes(image.size);
    const openFolder = document.createElement("button");
    openFolder.type = "button";
    openFolder.className = "text-button inline";
    openFolder.textContent = "打开目录";
    openFolder.addEventListener("click", () => openImageFolder(image.relative_path));
    footer.append(size, openFolder);
    info.append(name, path, footer);
    card.append(thumbnail, info);
    grid.append(card);
  });
  $("#imageCountLabel").textContent = `${filtered.length} 张图片`;
  $("#imageEmptyState").classList.toggle("hidden", filtered.length > 0);
}

function updateImageViewerCaption() {
  const viewer = state.imageViewer;
  const dimensions = viewer.width && viewer.height ? `${viewer.width} × ${viewer.height}px` : "读取尺寸中";
  $("#imagePreviewCaption").textContent = `${viewer.relativePath} · ${dimensions} · ${formatBytes(viewer.size)} · ${Math.round(viewer.scale * 100)}% · ${viewer.rotation}°`;
}

function applyImageTransform() {
  const viewer = state.imageViewer;
  $("#imagePreview").style.transform = `translate3d(${viewer.x}px, ${viewer.y}px, 0) scale(${viewer.scale}) rotate(${viewer.rotation}deg)`;
  updateImageViewerCaption();
}

function resetImageViewer() {
  Object.assign(state.imageViewer, { scale: 1, rotation: 0, x: 0, y: 0, dragging: false });
  applyImageTransform();
}

function showImagePreview(image) {
  Object.assign(state.imageViewer, {
    relativePath: image.relative_path,
    name: image.name,
    url: image.url,
    size: image.size,
    modified: image.modified,
    scale: 1,
    rotation: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  const preview = $("#imagePreview");
  preview.src = image.url;
  $("#imageNameText").textContent = image.name;
  $("#imageNameText").classList.remove("hidden");
  $("#imageNameEdit").classList.add("hidden");
  preview.alt = image.name;
  preview.style.transform = "none";
  const dialog = $("#imageDialog");
  if (!dialog.open) dialog.showModal();
  const loadDimensions = () => {
    state.imageViewer.width = preview.naturalWidth || 0;
    state.imageViewer.height = preview.naturalHeight || 0;
    updateImageViewerCaption();
  };
  if (preview.complete) loadDimensions();
  else preview.addEventListener("load", loadDimensions, { once: true });
  updateImageViewerCaption();
}

function zoomImageView(delta) {
  const viewer = state.imageViewer;
  viewer.scale = Math.min(8, Math.max(0.1, viewer.scale + delta));
  applyImageTransform();
}

function rotateImageView(delta) {
  state.imageViewer.rotation = (state.imageViewer.rotation + delta) % 360;
  applyImageTransform();
}

function getFileParts(name) {
  const index = name.lastIndexOf(".");
  if (index <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, index), extension: name.slice(index) };
}

function enterImageRenameMode() {
  if (!state.imageViewer.relativePath) return;
  const parts = getFileParts(state.imageViewer.name);
  state.imageViewer.renaming = true;
  $("#imageNameInput").value = parts.stem;
  $("#imageNameExtension").textContent = parts.extension;
  $("#imageNameOverlay").classList.add("renaming");
  $("#imageNameText").classList.add("hidden");
  $("#imageNameEdit").classList.remove("hidden");
  $("#imageNameInput").focus();
  $("#imageNameInput").select();
}

function cancelImageRename() {
  state.imageViewer.renaming = false;
  $("#imageNameOverlay").classList.remove("renaming");
  $("#imageNameEdit").classList.add("hidden");
  $("#imageNameText").classList.remove("hidden");
}

async function saveInlineImageRename(overwrite = false) {
  if (!state.imageViewer.renaming) return;
  const requestedStem = $("#imageNameInput").value.trim();
  if (!requestedStem) {
    cancelImageRename();
    return;
  }
  const currentStem = getFileParts(state.imageViewer.name).stem;
  if (requestedStem === currentStem && !overwrite) {
    cancelImageRename();
    return;
  }
  if (state.status?.preview?.status === "running") {
    try {
      await stopPreview({ silent: true, forRename: true });
    } catch (error) {
      toast("无法停止本地预览", `${error.message} 请手动停止预览后再重命名。`, "error", 8000);
      cancelImageRename();
      return;
    }
  }
  try {
    const result = await api("/api/images/rename", {
      method: "POST",
      body: JSON.stringify({ relative_path: state.imageViewer.relativePath, new_name: requestedStem, overwrite }),
    });
    state.imageViewer.name = result.name;
    state.imageViewer.relativePath = result.relative_path;
    state.imageViewer.url = result.url;
    $("#imagePreview").src = result.url;
    $("#imageNameText").textContent = result.name;
    cancelImageRename();
    await loadImages({ quiet: true });
    const updated = state.images.find((item) => item.relative_path === result.relative_path);
    if (updated) showImagePreview(updated);
    toast("图片已重命名", result.relative_path, "success");
  } catch (error) {
    if (error.status === 409 && error.details?.conflict) {
      const confirmed = window.confirm(`文件“${requestedStem}${getFileParts(state.imageViewer.name).extension}”已存在，是否覆盖？`);
      if (confirmed) {
        await saveInlineImageRename(true);
      } else {
        cancelImageRename();
      }
    } else {
      toast("重命名失败", error.message, "error");
      cancelImageRename();
    }
  }
}

function openImageRenameDialog() {
  enterImageRenameMode();
}


async function openImageFolder(relativePath = "") {
  try {
    await api("/api/images/open-folder", { method: "POST", body: JSON.stringify({ relative_path: relativePath }) });
  } catch (error) {
    toast("无法打开图片目录", error.message, "error");
  }
}

async function selectBlogFolder() {
  const button = $("#selectFolderButton");
  setButtonBusy(button, true, "等待选择...");
  try {
    const result = await api("/api/select-folder", { method: "POST", body: "{}" });
    if (result.cancelled) return;
    await loadStatus({ attachPreview: false });
    await Promise.all([loadSiteConfig({ quiet: true }), loadThemeConfig({ quiet: true }), loadPosts({ quiet: true }), loadImages({ quiet: true })]);
    if (!result.site_config_exists) toast("未找到 _config.yml", "请确认当前文件夹是 Hexo 博客根目录。", "warning", 6000);
    else if (!result.theme_config_exists) toast("没有找到 Butterfly 配置", "主题配置页面暂不可用。", "warning", 6000);
    else toast("博客文件夹已更新", result.blog_dir, "success");
  } catch (error) {
    toast("无法选择文件夹", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function updateTaskStatus(task) {
  const element = $("#taskStatus");
  if (!task) { element.classList.add("hidden"); return; }
  const labels = { running: "运行中", success: "已完成", failed: "失败", stopped: "已停止" };
  element.className = `task-status ${task.status}`;
  element.innerHTML = `<span></span><b>${labels[task.status] || task.status}</b>`;
  element.classList.remove("hidden");
}

function updateLogHistoryMeta() {
  const history = state.logHistory;
  $("#logHistoryMeta").textContent = history.total
    ? `共 ${history.total} 行，已加载 ${history.lines.length} 行`
    : "暂无历史日志";
  $("#loadMoreLogsButton").disabled = history.loading || !history.hasMore;
}

async function loadLogHistory(reset = false) {
  const history = state.logHistory;
  if (history.loading) return;
  history.loading = true;
  updateLogHistoryMeta();
  try {
    const offset = reset ? 0 : history.offset;
    const data = await api(`/api/logs?limit=200&offset=${offset}`, { cache: "no-store" });
    const incoming = Array.isArray(data.lines) ? data.lines : [];
    history.lines = reset ? incoming : [...incoming, ...history.lines];
    history.offset = data.offset || 0;
    history.total = data.total || 0;
    history.hasMore = Boolean(data.has_more);
    $("#logHistoryContent").textContent = history.lines.length ? history.lines.join("\n") : "暂无历史日志";
    if (reset) $("#logHistoryContent").scrollTop = $("#logHistoryContent").scrollHeight;
  } catch (error) {
    toast("无法读取历史日志", error.message, "error");
  } finally {
    history.loading = false;
    updateLogHistoryMeta();
  }
}

async function openLogHistory() {
  state.logHistory = { offset: 0, lines: [], total: 0, hasMore: false, loading: false };
  $("#logHistoryContent").textContent = "正在读取日志...";
  $("#logHistoryDialog").showModal();
  await loadLogHistory(true);
}

function closeLogHistory() {
  $("#logHistoryDialog").close();
}

async function downloadLogHistory() {
  const link = document.createElement("a");
  link.href = "/api/logs/download";
  link.download = "blogmanager.log";
  document.body.append(link);
  link.click();
  link.remove();
}

async function clearPersistentLogs() {
  if (!window.confirm("确定清空所有历史日志吗？此操作不可撤销。")) return;
  try {
    await api("/api/logs", { method: "DELETE", body: "{}" });
    clearLog();
    state.logHistory = { offset: 0, lines: [], total: 0, hasMore: false, loading: false };
    $("#logHistoryContent").textContent = "暂无历史日志";
    updateLogHistoryMeta();
    toast("历史日志已清空", "", "success");
  } catch (error) {
    toast("无法清空历史日志", error.message, "error");
  }
}

function clearLog() {
  state.logEntries = [];
  const output = $("#logOutput");
  output.replaceChildren();
  const placeholder = document.createElement("div");
  placeholder.className = "log-placeholder";
  placeholder.id = "logPlaceholder";
  placeholder.innerHTML = '<svg><use href="#i-terminal"></use></svg><span>部署或预览命令的输出会显示在这里</span>';
  output.append(placeholder);
  $("#logSubtitle").textContent = "等待命令";
  updateTaskStatus(null);
}

function appendLog(line) {
  state.logEntries.push(line);
  const output = $("#logOutput");
  $("#logPlaceholder")?.remove();
  const row = document.createElement("div");
  row.className = `log-line ${line.level || "stdout"}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = line.time || "";
  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = line.text ?? "";
  row.append(time, text);
  output.append(row);
  output.scrollTop = output.scrollHeight;
}

async function copyLog() {
  const text = state.logEntries.map((line) => `[${line.time || ""}] ${line.text || ""}`).join("\n");
  if (!text) { toast("日志为空", "", "info", 2000); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch (_error) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("日志已复制", "", "success", 2000);
}

function closeEventSource() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
}

function setTaskButtonState(task, running) {
  if (!task) return;
  if (task.kind === "deploy") {
    const button = $("#deployButton");
    button.disabled = running;
    const label = $("span", button);
    if (label) label.textContent = running ? "正在部署..." : "开始部署";
  }
  if (task.kind === "preview") {
    const button = $("#previewButton");
    button.disabled = running;
    const label = $("span", button);
    if (label) label.textContent = running ? "预览运行中..." : "启动预览";
  }
  if (task.kind === "autodeploy") {
    const button = $("#autoDeployButton");
    button.disabled = running;
    const label = $("span", button);
    if (label) label.textContent = running ? "自动部署进行中..." : "打开自动部署向导";
  }
  if (task.kind === "clone") {
    const button = $("#startCloneButton");
    button.disabled = running;
    const label = $("span", button);
    if (label) label.textContent = running ? "克隆中..." : "开始克隆";
  }
  if (task.kind === "generate") {
    const button = $("#forceGenerateButton");
    button.disabled = running;
    const label = $("span", button);
    if (label) label.textContent = running ? "生成中..." : "强制重新生成";
  }
}

function attachTask(task, options = {}) {
  const { preserveLog = false, quiet = false, onDone = null } = options;
  closeEventSource();
  state.activeTaskId = task.id;
  state.activeTaskKind = task.kind;
  if (task.kind === "preview") {
    state.status = state.status || {};
    state.status.preview = task;
    updatePreviewUi(task);
  }
  if (!preserveLog) clearLog();
  $("#logSubtitle").textContent = task.command;
  $("#logPanel").classList.remove("collapsed");
  $(".workspace").classList.remove("log-collapsed");
  updateTaskStatus(task);
  setTaskButtonState(task, true);
  const source = new EventSource(`/api/tasks/${encodeURIComponent(task.id)}/events?after=0`);
  state.eventSource = source;
  source.addEventListener("log", (event) => {
    try { appendLog(JSON.parse(event.data)); } catch (_error) { appendLog({ level: "stdout", text: event.data }); }
  });
  source.addEventListener("done", (event) => {
    let finished = task;
    try { finished = JSON.parse(event.data); } catch (_error) { /* keep snapshot */ }
    source.close();
    state.eventSource = null;
    state.activeTaskId = null;
    state.activeTaskKind = null;
    updateTaskStatus(finished);
    setTaskButtonState(finished, false);
    if (finished.kind === "preview") {
      updatePreviewUi(finished);
      loadStatus({ attachPreview: false }).catch(() => {});
    }
    if ((finished.kind === "autodeploy" || finished.kind === "clone") && finished.status === "success") {
      loadStatus({ attachPreview: false }).then(async () => { await enterWorkspace(); activateSection("operations"); const message = finished.local_only ? "仅本地博客已创建，可点击“本地预览”。" : "已切换到新博客目录，可点击“一键部署”。"; toast("自动部署完成", message, "success", 7000); }).catch(() => {});
    }
    if (!quiet) {
      const type = finished.status === "success" ? "success" : finished.status === "stopped" ? "warning" : "error";
      const title = finished.status === "success" ? "任务执行完成" : finished.status === "stopped" ? "任务已停止" : "任务执行失败";
      toast(title, finished.command, type);
    }
    if (typeof onDone === "function") onDone(finished);
  });
  source.onerror = () => { if (state.eventSource) $("#logSubtitle").textContent = `${task.command} · 连接中断，正在重连`; };
}

async function startCommand(kind) {
  const button = kind === "deploy" ? $("#deployButton") : $("#previewButton");
  const label = kind === "deploy" ? "正在启动..." : "正在检查端口...";
  setButtonBusy(button, true, label);
  try {
    const port = Number($("#previewPort").value || 4000);
    const payload = kind === "preview" ? { port } : {};
    const data = await api(`/api/commands/${kind}`, { method: "POST", body: JSON.stringify(payload) });
    attachTask(data.task, { preserveLog: false });
    if (data.already_running) toast("预览服务已在运行", "已连接到现有任务日志。", "info");
  } catch (error) {
    if (kind === "preview" && error.details?.dependency_issue) {
      state.previewDependencies = error.details.dependency_status || null;
      renderPreviewDependencyIssues(state.previewDependencies);
      const dialog = $("#previewDependencyDialog");
      if (!dialog.open) dialog.showModal();
    } else if (kind === "preview" && error.details?.suggested_port) {
      $("#previewPortState").textContent = `端口 ${error.details.port} 已占用，建议 ${error.details.suggested_port}`;
      $("#previewPortState").className = "occupied";
      updateSuggestedPortButton(error.details.suggested_port);
      toast("预览端口被占用", `可点击“使用建议端口”自动改用 ${error.details.suggested_port}。`, "warning", 6500);
    } else {
      toast(kind === "deploy" ? "无法开始部署" : "无法启动预览", error.message, "error");
    }
  } finally {
    setButtonBusy(button, false);
    if (state.activeTaskKind === kind) setTaskButtonState({ kind }, true);
  }
}

function applyProjectMode(localOnly) {
  const deployCard = $("#deployCard");
  if (deployCard) deployCard.classList.toggle("hidden", localOnly);
  document.body.classList.toggle("project-local-only", localOnly);
}
function previewCommandMarkup(port) {
  const safePort = Number.isInteger(Number(port)) ? Number(port) : 4000;
  return `<span>$</span> hexo clean<br><span>$</span> hexo generate<br><span>$</span> hexo server -p ${safePort}`;
}

function updatePreviewUi(preview) {
  const running = Boolean(preview && preview.status === "running");
  const port = preview?.port || Number($("#previewPort").value || 4000);
  const pill = $("#previewStatusPill");
  pill.className = `status-pill ${running ? "running" : "neutral"}`;
  pill.innerHTML = `<span></span>${running ? `预览运行中 · ${port}` : "预览未运行"}`;
  $("#previewButton").disabled = running;
  $("#stopPreviewButton").disabled = !running;
}

async function stopPreview(options = {}) {
  const { silent = false } = options;
  const preview = state.status?.preview;
  if (!preview || preview.status !== "running") return;
  const button = $("#stopPreviewButton");
  setButtonBusy(button, true, "停止中...");
  try {
    if (state.activeTaskId !== preview.id) attachTask(preview, { preserveLog: true, quiet: true });
    await api(`/api/commands/${encodeURIComponent(preview.id)}/stop`, { method: "POST", body: "{}" });
    for (let index = 0; index < 12; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await loadStatus({ attachPreview: false });
      if (!state.status.preview || state.status.preview.status !== "running") break;
    }
    if (!silent) toast("预览已停止", "端口已释放，可以重新启动。", "success");
  } catch (error) {
    if (!silent) toast("停止失败", error.message, "error");
    throw error;
  } finally {
    setButtonBusy(button, false);
    updatePreviewUi(state.status?.preview);
  }
}

function renderPreviewDependencyIssues(status) {
  const list = $("#previewDependencyIssues");
  list.replaceChildren();
  const issues = status?.issues?.length ? status.issues : ["依赖检查未通过，请查看后端日志。"];
  issues.forEach((issue) => {
    const item = document.createElement("div");
    item.className = "source-status unavailable";
    const text = document.createElement("span");
    text.textContent = issue;
    const mark = document.createElement("strong");
    mark.textContent = "不通过";
    item.append(text, mark);
    list.append(item);
  });
  (status?.warnings || []).forEach((warning) => {
    const item = document.createElement("div");
    item.className = "source-status warning";
    const text = document.createElement("span");
    text.textContent = warning;
    const mark = document.createElement("strong");
    mark.textContent = "提示";
    item.append(text, mark);
    list.append(item);
  });
}

async function checkPreviewDependencies() {
  try {
    const status = await api("/api/preview/dependencies", { cache: "no-store" });
    if (status.ok) return true;
    state.previewDependencies = status;
    renderPreviewDependencyIssues(status);
    const dialog = $("#previewDependencyDialog");
    if (!dialog.open) dialog.showModal();
    return false;
  } catch (error) {
    toast("无法检查预览依赖", `${error.message} 请稍后重试。`, "error", 7000);
    return false;
  }
}

async function repairPreviewDependencies() {
  const button = $("#repairPreviewDependenciesButton");
  setButtonBusy(button, true, "修复中...");
  try {
    const data = await api("/api/dependencies/repair", { method: "POST", body: "{}" });
    $("#previewDependencyDialog").close();
    await new Promise((resolve) => {
      attachTask(data.task, {
        preserveLog: false,
        onDone: async (finished) => {
          try {
            if (finished.status === "success") {
              toast("依赖已修复", "正在重新检查并启动本地预览。", "success", 5000);
              await requestPreview();
            } else {
              toast("依赖修复失败", finished.error_message || "请查看运行日志。", "error", 9000);
            }
          } finally {
            resolve();
          }
        },
      });
    });
  } catch (error) {
    toast("无法修复预览依赖", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function updateSuggestedPortButton(port) {
  const button = $("#useSuggestedPortButton");
  if (!button) return;
  const value = Number(port);
  if (Number.isInteger(value) && value >= 1024 && value <= 65535) {
    button.dataset.port = String(value);
    button.classList.remove("hidden");
  } else {
    button.dataset.port = "";
    button.classList.add("hidden");
  }
}

async function useSuggestedPreviewPort() {
  const button = $("#useSuggestedPortButton");
  const port = Number(button?.dataset.port || 0);
  if (!(port >= 1024 && port <= 65535)) return;
  const input = $("#previewPort");
  input.value = String(port);
  localStorage.setItem("blog-manager-preview-port", String(port));
  $(".preview-card .command-line").innerHTML = previewCommandMarkup(port);
  button.classList.add("hidden");
  toast("已切换到建议端口", `将使用端口 ${port} 重新启动预览。`, "info", 3500);
  await requestPreview();
}

async function checkPreviewPort(showToast = false) {
  const port = Number($("#previewPort").value || 4000);
  const stateLabel = $("#previewPortState");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    stateLabel.textContent = "端口范围应为 1024-65535";
    stateLabel.className = "occupied";
    return { occupied: true, suggested_port: 4000 };
  }
  try {
    const result = await api(`/api/preview/check?port=${encodeURIComponent(port)}`, { cache: "no-store" });
    stateLabel.textContent = result.occupied ? `已占用，建议 ${result.suggested_port}` : "端口可用";
    stateLabel.className = result.occupied ? "occupied" : "available";
    updateSuggestedPortButton(result.occupied ? result.suggested_port : "");
    localStorage.setItem("blog-manager-preview-port", String(port));
    $(".preview-card .command-line").innerHTML = previewCommandMarkup(port);
    if (showToast && result.occupied) toast("端口已被占用", `可改用 ${result.suggested_port} 或其他端口。`, "warning");
    return result;
  } catch (error) {
    stateLabel.textContent = "检查失败";
    stateLabel.className = "occupied";
    return { occupied: false, suggested_port: 4000 };
  }
}

async function requestDeploy() {
  if (hasUnsavedChanges()) {
    state.pendingDeploy = true;
    $("#unsavedDialog").showModal();
    return;
  }
  await startCommand("deploy");
}

async function requestPreview() {
  if (state.status?.preview?.status === "running") {
    try {
      await stopPreview({ silent: true });
    } catch (error) {
      toast("无法停止旧预览", `${error.message} 请手动结束进程后重试。`, "error", 8000);
      return;
    }
  }
  if (!(await checkPreviewDependencies())) return;
  const result = await checkPreviewPort(true);
  if (result.occupied) {
    $("#previewPort").focus();
    return;
  }
  await startCommand("preview");
}

async function forceGenerate() {
  if (state.status?.preview?.status === "running") {
    const confirmed = window.confirm("本地预览正在运行。重新生成后可能需要重启预览，是否继续？");
    if (!confirmed) return;
  }
  const button = $("#forceGenerateButton");
  setButtonBusy(button, true, "生成中...");
  try {
    const data = await api("/api/commands/generate", { method: "POST", body: "{}" });
    attachTask(data.task, { preserveLog: false });
    if (data.already_running) toast("已有生成任务", "已连接到现有任务日志。", "info");
    else toast("强制重新生成已开始", "将执行 hexo clean 和 hexo generate。", "info", 5000);
  } catch (error) {
    toast("无法重新生成静态文件", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function openBlogFolder() {
  try { await api("/api/open-folder", { method: "POST", body: "{}" }); }
  catch (error) { toast("无法打开文件夹", error.message, "error"); }
}

function applyThemeSourceSelection() {
  const source = $("#autoDeployThemeSource").value;
  if (source !== "custom" && THEME_SOURCE_URLS[source]) {
    state.autoDeploy.settingRepo = true;
    $("#autoDeployThemeRepo").value = THEME_SOURCE_URLS[source];
    state.autoDeploy.settingRepo = false;
  }
}

function promptThemeNetworkFallback(result) {
  return new Promise((resolve) => {
    const dialog = $("#themeNetworkDialog");
    const list = $("#themeNetworkSources");
    list.replaceChildren();
    (result.sources || []).forEach((source) => {
      const item = document.createElement("div");
      item.className = `source-status ${source.reachable ? "available" : "unavailable"}`;
      item.innerHTML = `<span>${escapeHtml(source.label)}</span><strong>${source.reachable ? "可达" : "不可达"}</strong>`;
      list.append(item);
    });
    const finish = (choice) => {
      if (dialog.open) dialog.close();
      resolve(choice);
    };
    $("#useThemeMirrorButton").onclick = () => {
      state.autoDeploy.skipTheme = false;
      $("#autoDeployThemeSource").value = "gitee";
      applyThemeSourceSelection();
      finish({ action: "mirror" });
    };
    $("#skipThemeButton").onclick = () => {
      state.autoDeploy.skipTheme = true;
      finish({ action: "skip" });
    };
    dialog.querySelector('button[value="cancel"]').onclick = () => finish(null);
    dialog.oncancel = (event) => { event.preventDefault(); finish(null); };
    dialog.showModal();
  });
}

async function checkThemeNetworkBeforeDeploy(themeRepo) {
  if (state.autoDeploy.skipTheme) return true;
  let result;
  try {
    result = await api("/api/autodeploy/check-theme-network", {
      method: "POST",
      body: JSON.stringify({ theme_repo: themeRepo }),
    });
  } catch (error) {
    toast("主题源检测失败", `${error.message} 将直接尝试克隆源。`, "warning", 6500);
    return true;
  }
  const selected = (result.sources || []).find((item) => item.id === result.selected_id);
  const selectedReachable = result.selected_reachable ?? selected?.reachable ?? result.reachable;
  if (selectedReachable) return true;
  const choice = await promptThemeNetworkFallback(result);
  if (!choice) return false;
  return true;
}
async function loadAutodeployDefaults() {
  const defaults = await api("/api/autodeploy/defaults", { cache: "no-store" });
  $("#autoDeployTitle").value = defaults.title || "";
  $("#autoDeployAuthor").value = defaults.author || "";
  $("#autoDeployUrl").value = defaults.url || "";
  $("#autoDeployRepo").value = defaults.repo_url || "";
  $("#autoDeployBranch").value = defaults.branch || "main";
  const themeRepo = defaults.theme_repo || THEME_SOURCE_URLS.github;
  $("#autoDeployThemeRepo").value = themeRepo;
  const matchingSource = Object.entries(THEME_SOURCE_URLS).find(([_key, url]) => url === themeRepo);
  $("#autoDeployThemeSource").value = matchingSource ? matchingSource[0] : "custom";
  state.autoDeploy.skipTheme = false;
  $("#autoDeployCopyContent").checked = Boolean(defaults.copy_content);
  $("#autoDeployCreateRepo").checked = defaults.auto_create_repo !== false;
  $("#autoDeployRepoPrivate").checked = Boolean(defaults.repo_private);
  state.autoDeploy.tokenSet = Boolean(defaults.github_token_set);
  $("#autoDeploySaveToken").checked = Boolean(defaults.save_token);
  $("#autoDeployGithubToken").value = "";
  $("#autoDeployGithubToken").placeholder = state.autoDeploy.tokenSet
    ? "已在本机保存 Token，留空则继续使用"
    : "github_pat_... 或 ghp_...";
  $("#autoDeployLocalOnly").checked = Boolean(defaults.local_only);
  state.autoDeploy.repoManual = false;
  updateAutodeployMode();
}

async function loadAutodeployPreflight() {
  const preflight = await api("/api/autodeploy/preflight", { cache: "no-store" });
  state.autoDeploy.preflight = preflight;
  const items = [
    ["Node.js", preflight.node],
    ["npm", preflight.npm],
    ["Git", preflight.git],
  ];
  $("#autoDeployPreflight").innerHTML = items.map(([name, info]) => `<span class="${info.available ? "available" : "missing"}">${info.available ? "✓" : "✕"} ${name}${info.version ? ` · ${escapeHtml(info.version)}` : ""}</span>`).join("");
  return preflight;
}

async function openAutodeployDialog() {
  try {
    await Promise.all([loadAutodeployDefaults(), loadAutodeployPreflight()]);
    $("#autodeployDialog").showModal();
  } catch (error) {
    toast("无法打开自动部署", error.message, "error");
  }
}

async function selectAutodeployFolder() {
  setButtonBusy($("#autoDeploySelectFolder"), true, "选择中...");
  try {
    const result = await api("/api/autodeploy/select-folder", { method: "POST", body: "{}" });
    if (result.cancelled) return;
    state.autoDeploy.target = result.path;
    state.autoDeploy.inspect = result.inspect;
    state.autoDeploy.mode = result.inspect.hexo ? "update" : "create";
    $("#autoDeployTarget").value = result.path;
    $("#autoDeployOverwrite").checked = result.inspect.hexo;
    if (result.inspect.non_empty && !result.inspect.hexo) {
      state.autoDeploy.target = "";
      $("#autoDeployTarget").value = "";
      toast("目标文件夹不可用", "该文件夹非空，请选择空文件夹或已有 Hexo 项目的文件夹。", "error", 6500);
    } else if (result.inspect.hexo) {
      const confirmed = window.confirm("该文件夹已有 Hexo 项目，是否更新主题并覆盖配置文件？");
      if (!confirmed) {
        state.autoDeploy.target = "";
        $("#autoDeployTarget").value = "";
        $("#autoDeployOverwrite").checked = false;
      } else {
        $("#autoDeployNotice").innerHTML = '<svg><use href="#i-info"></use></svg><div><strong>更新模式</strong><span>将更新 Butterfly 主题、安装依赖，并按勾选项覆盖站点配置。</span></div>';
      }
    } else {
      $("#autoDeployNotice").innerHTML = '<svg><use href="#i-info"></use></svg><div><strong>全新部署</strong><span>将初始化 Hexo、安装 Butterfly、应用配置并生成站点。</span></div>';
    }
  } catch (error) {
    toast("无法选择目标文件夹", error.message, "error");
  } finally {
    setButtonBusy($("#autoDeploySelectFolder"), false);
  }
}

function updateAutodeployMode() {
  const localOnly = $("#autoDeployLocalOnly").checked;
  state.autoDeploy.localOnly = localOnly;
  ["autoDeployTitle", "autoDeployAuthor", "autoDeployUrl", "autoDeployCreateRepo", "autoDeployRepoPrivate", "autoDeployGithubToken", "autoDeploySaveToken", "autoDeployRepo", "autoDeployBranch"].forEach((id) => {
    $(`#${id}`).disabled = localOnly;
  });
  $("#autoDeployGithubHint").textContent = localOnly
    ? "仅本地模式：跳过仓库创建、Token 校验和 deploy 配置。"
    : "仓库地址会根据站点 URL 自动推导；也可手动修改。";
}
async function inferRepoFromSiteUrl() {
  if (state.autoDeploy.repoManual) return;
  const siteUrl = $("#autoDeployUrl").value.trim();
  if (!siteUrl) return;
  try {
    const result = await api(`/api/autodeploy/infer-repo?url=${encodeURIComponent(siteUrl)}`, { cache: "no-store" });
    if (result.repo_url && !state.autoDeploy.repoManual) {
      state.autoDeploy.settingRepo = true;
      $("#autoDeployRepo").value = result.repo_url;
      state.autoDeploy.settingRepo = false;
      $("#autoDeployGithubHint").textContent = `已根据站点 URL 推导仓库地址：${result.repo_url}`;
    }
  } catch (_error) {
    // Inference is optional; the user can enter the repository manually.
  }
}
function renderProgressSteps(task) {
  const container = $("#progressSteps");
  container.replaceChildren();
  (task.steps || []).forEach((step) => {
    const row = document.createElement("div");
    row.className = `progress-step ${step.status === "running" ? "active" : ""} ${step.status === "success" ? "done" : ""} ${step.status === "failed" ? "failed" : ""}`;
    row.dataset.stepId = step.id;
    const marker = document.createElement("span");
    marker.className = "step-marker";
    marker.textContent = step.status === "success" ? "✓" : step.status === "failed" ? "!" : "·";
    const copy = document.createElement("span");
    copy.className = "step-copy";
    const title = document.createElement("strong");
    title.textContent = step.title;
    const detail = document.createElement("small");
    detail.textContent = step.detail || (step.status === "pending" ? "待执行" : step.status === "running" ? "执行中..." : "");
    copy.append(title, detail);
    row.append(marker, copy);
    container.append(row);
  });
  updateProgressSummary(task.steps || []);
}

function updateProgressStep(data) {
  const row = document.querySelector(`.progress-step[data-step-id="${data.id}"]`);
  if (!row) return;
  row.classList.toggle("active", data.status === "running");
  row.classList.toggle("done", data.status === "success");
  row.classList.toggle("failed", data.status === "failed");
  const marker = $(".step-marker", row);
  marker.textContent = data.status === "success" ? "✓" : data.status === "failed" ? "!" : "·";
  const detail = $("small", row);
  detail.textContent = data.detail || (data.status === "running" ? "执行中..." : data.status === "success" ? "已完成" : data.status === "failed" ? "失败" : "待执行");
  $("#progressCurrentStep").textContent = data.detail || $( "strong", row).textContent;
  const states = $$(".progress-step").map((item) => item.classList.contains("done") ? "success" : item.classList.contains("failed") ? "failed" : item.classList.contains("active") ? "running" : "pending");
  updateProgressSummary(states.map((status) => ({ status })));
}

function updateProgressSummary(steps) {
  const total = steps.length;
  const done = steps.filter((step) => step.status === "success").length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  $("#progressCount").textContent = `${done}/${total} 步`;
  $("#progressPercent").textContent = `${percent}%`;
  $("#progressBar").style.width = `${percent}%`;
}

function appendProgressLog(line) {
  const output = $("#progressLog");
  $(".progress-log-empty", output)?.remove();
  const row = document.createElement("div");
  row.className = `progress-log-line ${line.level || "stdout"}`;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = line.time || "";
  const text = document.createElement("span");
  text.textContent = line.text || "";
  row.append(time, text);
  output.append(row);
  output.scrollTop = output.scrollHeight;
}

function openAutodeployProgress(task) {
  closeEventSource();
  state.activeTaskId = task.id;
  state.activeTaskKind = task.kind;
  state.autoDeploy.progressTaskId = task.id;
  $("#cancelAutodeployButton").textContent = "取消部署";
  $("#progressLog").innerHTML = '<div class="progress-log-empty">等待步骤输出...</div>';
  $("#progressCurrentStep").textContent = "准备部署环境...";
  $("#progressResult").classList.add("hidden");
  $("#progressResult").className = "progress-footer hidden";
  $("#cancelAutodeployButton").disabled = false;
  renderProgressSteps(task);
  const progressDialog = $("#autodeployProgressDialog");
  if (!progressDialog.open) progressDialog.showModal();
  const source = new EventSource(`/api/tasks/${encodeURIComponent(task.id)}/events?after=0`);
  state.eventSource = source;
  source.addEventListener("log", (event) => {
    try { appendProgressLog(JSON.parse(event.data)); } catch (_error) { appendProgressLog({ level: "stdout", text: event.data }); }
  });
  source.addEventListener("step", (event) => {
    try { updateProgressStep(JSON.parse(event.data)); } catch (_error) { }
  });
  source.addEventListener("done", (event) => {
    let finished = task;
    try { finished = JSON.parse(event.data); } catch (_error) { }
    source.close();
    state.eventSource = null;
    state.activeTaskId = null;
    state.activeTaskKind = null;
    state.autoDeploy.progressTaskId = finished.id;
    $("#cancelAutodeployButton").disabled = false;
    $("#cancelAutodeployButton").textContent = "返回主界面";
    renderProgressSteps(finished);
    const footer = $("#progressResult");
    footer.classList.remove("hidden");
    footer.className = `progress-footer ${finished.status}`;
    const failureText = finished.error_message || "请查看日志，修正问题后点击重试。";
    const failureHint = finished.failed_step === "theme"
      ? " 请检查网络连接，确认可以访问 GitHub/Gitee；也可以在下方打开 themes 目录，手动放入 Butterfly 主题后重试。网络环境不稳定时可配置 Git 代理。"
      : " 请先根据日志修正问题，再点击重试当前步骤。";
    $("#progressResultTitle").textContent = finished.status === "success" ? "自动部署已完成" : finished.status === "stopped" ? "自动部署已取消" : "自动部署失败";
    $("#progressResultText").textContent = finished.status === "success" ? "博客已准备好，可以先进行本地预览。" : `${failureText}${finished.status === "failed" ? failureHint : ""}`;
    const themeStepFailed = finished.status === "failed" && finished.failed_step === "theme";
    const pugRenderFailed = finished.status === "failed" && finished.failed_step === "generate" && /pug|renderer/i.test(finished.error_message || "");
    const dependencyStepFailed = finished.status === "failed" && ["deps", "deps-check"].includes(finished.failed_step);
    const canRepairDependencies = dependencyStepFailed || pugRenderFailed;
    $("#previewAfterDeployButton").classList.toggle("hidden", finished.status !== "success");
    $("#retryAutodeployButton").classList.toggle("hidden", finished.status !== "failed");
    $("#openThemeFolderButton").classList.toggle("hidden", !themeStepFailed);
    $("#repairDependenciesButton").classList.toggle("hidden", !canRepairDependencies);
    $("#repairDependenciesButton").textContent = pugRenderFailed ? "重新安装渲染器" : "修复依赖";
    $("#progressThemeSourceWrap").classList.toggle("hidden", !themeStepFailed);
    if (themeStepFailed) {
      const source = $("#autoDeployThemeSource").value;
      $("#progressThemeSource").value = Object.prototype.hasOwnProperty.call(THEME_SOURCE_URLS, source) ? source : "__current__";
    }
  });
  source.onerror = () => {
    if (state.eventSource) $("#progressCurrentStep").textContent = "日志连接中断，正在重连...";
  };
}

async function cancelAutodeployProgress() {
  if (!state.activeTaskId) {
    $("#autodeployProgressDialog").close();
    await loadStatus({ attachPreview: false });
    await enterWorkspace();
    activateSection("operations");
    return;
  }
  if (!window.confirm("确定取消本次自动部署吗？已完成的步骤会保留。")) return;
  try {
    await api(`/api/commands/${encodeURIComponent(state.activeTaskId)}/stop`, { method: "POST", body: "{}" });
  } catch (error) {
    toast("取消失败", error.message, "error");
  }
}

async function retryAutodeployFromProgress() {
  if (!state.autoDeploy.progressTaskId) return;
  const button = $("#retryAutodeployButton");
  setButtonBusy(button, true, "重新启动中...");
  try {
    const data = await api(`/api/autodeploy/${encodeURIComponent(state.autoDeploy.progressTaskId)}/retry`, {
      method: "POST",
      body: JSON.stringify({
        theme_repo: $("#autoDeployThemeRepo").value.trim(),
        skip_theme: state.autoDeploy.skipTheme,
      }),
    });
    openAutodeployProgress(data.task);
  } catch (error) {
    toast("无法重试部署", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function repairAutodeployDependencies() {
  if (!state.autoDeploy.progressTaskId) return;
  const button = $("#repairDependenciesButton");
  setButtonBusy(button, true, "修复中...");
  try {
    const data = await api(`/api/autodeploy/${encodeURIComponent(state.autoDeploy.progressTaskId)}/repair-dependencies`, {
      method: "POST",
      body: "{}",
    });
    openAutodeployProgress(data.task);
  } catch (error) {
    toast("无法修复自动部署依赖", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function openAutodeployThemeFolder() {
  if (!state.autoDeploy.progressTaskId) return;
  try {
    await api(`/api/autodeploy/${encodeURIComponent(state.autoDeploy.progressTaskId)}/open-theme-dir`, { method: "POST", body: "{}" });
  } catch (error) {
    toast("无法打开 themes 目录", error.message, "error");
  }
}
async function previewAfterAutodeploy() {
  $("#autodeployProgressDialog").close();
  await loadStatus({ attachPreview: false });
  await enterWorkspace();
  await requestPreview();
}
async function startAutodeploy() {
  if (!state.autoDeploy.target) {
    toast("请先选择目标文件夹", "", "warning");
    return;
  }
  const localOnly = $("#autoDeployLocalOnly").checked;
  const autoCreateRepo = $("#autoDeployCreateRepo").checked;
  if (!(await checkThemeNetworkBeforeDeploy($("#autoDeployThemeRepo").value.trim()))) return;
  const repoUrl = $("#autoDeployRepo").value.trim();
  const githubToken = $("#autoDeployGithubToken").value.trim();
  const usingSavedToken = !githubToken && state.autoDeploy.tokenSet;
  if (!localOnly && !repoUrl) { toast("缺少仓库地址", "请填写 GitHub 仓库地址，或填写可推导的用户名 GitHub Pages URL。", "warning"); return; }
  if (!localOnly && autoCreateRepo && (githubToken || usingSavedToken)) {
    try {
      const repoResult = await api("/api/github/ensure-repo", { method: "POST", body: JSON.stringify({ repo_url: repoUrl, token: githubToken, private: $("#autoDeployRepoPrivate").checked }) });
      if (repoResult.exists && !repoResult.created) {
        if (!window.confirm("仓库已存在，是否直接使用？")) return;
      } else if (repoResult.created) {
        toast("远程仓库已创建", `${repoResult.owner}/${repoResult.repo}`, "success");
      }
    } catch (error) {
      toast("GitHub 仓库创建失败", `${error.message} 请检查 Token、权限、网络，或手动创建仓库后重试。`, "error", 10000);
      return;
    }
  } else if (!localOnly && autoCreateRepo && !githubToken && !usingSavedToken) {
    toast("未提供 GitHub Token", "请手动创建仓库，或填写已有仓库地址后继续。", "warning", 8000);
  }
  const button = $("#startAutoDeployButton");
  setButtonBusy(button, true, "启动中...");
  try {
    const data = await api("/api/autodeploy", {
      method: "POST",
      body: JSON.stringify({
        target_dir: state.autoDeploy.target,
        confirm_update: state.autoDeploy.mode !== "update" || $("#autoDeployOverwrite").checked,
        title: $("#autoDeployTitle").value,
        author: $("#autoDeployAuthor").value,
        url: $("#autoDeployUrl").value,
        repo_url: $("#autoDeployRepo").value,
        branch: $("#autoDeployBranch").value,
        theme_repo: $("#autoDeployThemeRepo").value,
        overwrite_config: $("#autoDeployOverwrite").checked,
        copy_content: $("#autoDeployCopyContent").checked,
        auto_create_repo: autoCreateRepo,
        local_only: localOnly,
        skip_theme: state.autoDeploy.skipTheme,
        repo_private: $("#autoDeployRepoPrivate").checked,
        save_token: $("#autoDeploySaveToken").checked,
        github_token: githubToken,
      }),
    });
    if (githubToken && $("#autoDeploySaveToken").checked) state.autoDeploy.tokenSet = true;
    $("#autodeployDialog").close();
    openAutodeployProgress(data.task);
  } catch (error) {
    toast("无法启动自动部署", error.message, "error", 7000);
  } finally {
    setButtonBusy(button, false);
  }
}
function renderRecentDirs() {
  const list = $("#recentList");
  if (!list) return;
  list.replaceChildren();
  const recent = state.status?.recent_dirs || [];
  $("#recentEmpty").classList.toggle("hidden", recent.length > 0);
  recent.forEach((path) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-item";
    button.innerHTML = `<svg><use href="#i-folder"></use></svg><span class="recent-copy"><strong>${escapeHtml(path.split(/[\\/]/).filter(Boolean).pop() || path)}</strong><small>${escapeHtml(path)}</small></span>`;
    button.addEventListener("click", () => openRecentFolder(path));
    list.append(button);
  });
}

function showWelcomeScreen() {
  $("#appShell").classList.add("hidden");
  $("#welcomeScreen").classList.remove("hidden");
  $("#rememberLastFolder").checked = Boolean(state.status?.remember_last);
  renderRecentDirs();
}

async function enterWorkspace() {
  $("#welcomeScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  activateSection(localStorage.getItem("blog-manager-section") || "site");
  await Promise.all([
    loadSiteConfig({ quiet: true }),
    loadThemeConfig({ quiet: true }),
    loadPosts({ quiet: true }),
    loadImages({ quiet: true }),
  ]);
  checkPreviewPort(false);
}

function showFirstRunGuide() {
  const dialog = $("#firstRunDialog");
  if (!dialog || dialog.open) return;
  const github = state.status?.github || {};
  $("#firstRunBlogPath").value = state.status?.blog_dir || "";
  $("#firstRunGithubUsername").value = github.username || "";
  $("#firstRunRepoUrl").value = github.repo_url || "";
  $("#firstRunBranch").value = github.branch || "main";
  $("#firstRunGithubToken").value = "";
  $("#firstRunGithubToken").placeholder = github.token_set ? "本机已保存 Token，留空则继续使用" : "可选，不会在界面回显";
  $("#firstRunRememberToken").checked = false;
  dialog.showModal();
}

async function selectFirstRunFolder() {
  const button = $("#firstRunSelectFolder");
  setButtonBusy(button, true, "选择中...");
  try {
    const result = await api("/api/select-folder", { method: "POST", body: "{}" });
    if (result.cancelled) return;
    $("#firstRunBlogPath").value = result.blog_dir;
    if (!result.site_config_exists) {
      toast("不是 Hexo 博客目录", "请选择包含 _config.yml 的文件夹。", "warning", 6500);
    } else {
      toast("博客目录已选择", result.blog_dir, "success");
    }
  } catch (error) {
    toast("无法选择博客目录", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function completeFirstRun() {
  const path = $("#firstRunBlogPath").value.trim();
  if (!path) {
    toast("请选择博客文件夹", "首次设置需要选择一个包含 _config.yml 的 Hexo 目录。", "warning");
    return;
  }
  const button = $("#completeFirstRunButton");
  setButtonBusy(button, true, "正在保存...");
  try {
    const status = await api("/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        path,
        github_username: $("#firstRunGithubUsername").value.trim(),
        repo_url: $("#firstRunRepoUrl").value.trim(),
        branch: $("#firstRunBranch").value.trim() || "main",
        github_token: $("#firstRunGithubToken").value.trim(),
        remember_token: $("#firstRunRememberToken").checked,
        remember_last: $("#rememberLastFolder").checked,
      }),
    });
    state.status = status;
    await loadStatus({ attachPreview: false });
    $("#firstRunDialog").close();
    await enterWorkspace();
    toast("首次设置已完成", "配置已保存到本机用户目录。", "success");
  } catch (error) {
    toast("首次设置保存失败", error.message, "error", 8000);
  } finally {
    setButtonBusy(button, false);
  }
}

async function resetLocalConfig() {
  if (!window.confirm("确定清理本机 Blog Manager 配置吗？博客文件和项目源码不会被删除。")) return;
  try {
    await api("/api/config/reset", { method: "POST", body: "{}" });
    if ($("#firstRunDialog").open) $("#firstRunDialog").close();
    await loadStatus({ attachPreview: false });
    showWelcomeScreen();
    showFirstRunGuide();
    toast("本地配置已清理", "下次启动仍会显示首次设置向导。", "success");
  } catch (error) {
    toast("无法清理本地配置", error.message, "error");
  }
}

async function markOnboardingForBlog(path) {
  const status = await api("/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ path, remember_last: $("#rememberLastFolder").checked }),
  });
  state.status = status;
  await loadStatus({ attachPreview: false });
  return status;
}

async function openRecentFolder(path) {
  try {
    await api("/api/blog-directory", { method: "POST", body: JSON.stringify({ path }) });
    await loadStatus({ attachPreview: false });
    if (!state.status.site_config_exists) {
      toast("最近目录不是 Hexo 博客", "请重新选择包含 _config.yml 的目录。", "warning", 6500);
      showWelcomeScreen();
      return;
    }
    await markOnboardingForBlog(path);
    await enterWorkspace();
    toast("已打开博客", path, "success");
  } catch (error) {
    toast("无法打开最近文件夹", error.message, "error");
  }
}

async function openExistingFromWelcome() {
  const button = $("#welcomeOpenExisting");
  setButtonBusy(button, true, "选择中...");
  try {
    const result = await api("/api/select-folder", { method: "POST", body: "{}" });
    if (result.cancelled) return;
    if (!result.site_config_exists) {
      toast("该文件夹不是 Hexo 博客", "请选择包含 _config.yml 的目录。", "warning", 6500);
      return;
    }
    await markOnboardingForBlog(result.blog_dir);
    if ($("#firstRunDialog").open) $("#firstRunDialog").close();
    await enterWorkspace();
    toast("博客已加载", result.blog_dir, "success");
  } catch (error) {
    toast("无法打开博客", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function openNewBlogFromWelcome() {
  await openAutodeployDialog();
}

async function openCloneBlogDialog() {
  $("#cloneTarget").value = "";
  $("#cloneRepoUrl").value = "";
  $("#cloneBranch").value = "main";
  $("#cloneBlogDialog").showModal();
}

async function selectCloneTarget() {
  const button = $("#cloneSelectFolder");
  setButtonBusy(button, true, "选择中...");
  try {
    const result = await api("/api/autodeploy/select-folder", { method: "POST", body: "{}" });
    if (result.cancelled) return;
    if (result.inspect.non_empty) {
      toast("目标文件夹非空", "克隆目标必须是空文件夹或尚不存在的目录。", "error", 6000);
      return;
    }
    $("#cloneTarget").value = result.path;
  } catch (error) {
    toast("无法选择文件夹", error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function startCloneBlog() {
  const target = $("#cloneTarget").value.trim();
  const repoUrl = $("#cloneRepoUrl").value.trim();
  const branch = $("#cloneBranch").value.trim();
  if (!target || !repoUrl) {
    toast("信息不完整", "请选择空文件夹并填写 Git 仓库地址。", "warning");
    return;
  }
  const button = $("#startCloneButton");
  setButtonBusy(button, true, "启动中...");
  try {
    const data = await api("/api/blog/clone", { method: "POST", body: JSON.stringify({ target_dir: target, repo_url: repoUrl, branch }) });
    $("#cloneBlogDialog").close();
    attachTask(data.task, { preserveLog: false });
    toast("克隆任务已启动", "详细日志显示在底部面板。", "info");
  } catch (error) {
    toast("无法启动克隆", error.message, "error", 7000);
  } finally {
    setButtonBusy(button, false);
  }
}
function bindWelcomeEvents() {
  $("#welcomeOpenExisting").addEventListener("click", openExistingFromWelcome);
  $("#welcomeNewBlog").addEventListener("click", openNewBlogFromWelcome);
  $("#welcomeCloneBlog").addEventListener("click", openCloneBlogDialog);
  $("#cloneSelectFolder").addEventListener("click", selectCloneTarget);
  $("#closeCloneDialog").addEventListener("click", () => $("#cloneBlogDialog").close());
  $("#startCloneButton").addEventListener("click", startCloneBlog);
  $("#firstRunForm").addEventListener("submit", (event) => event.preventDefault());
  $("#firstRunSelectFolder").addEventListener("click", selectFirstRunFolder);
  $("#completeFirstRunButton").addEventListener("click", completeFirstRun);
  $("#skipFirstRunButton").addEventListener("click", () => $("#firstRunDialog").close());
  $("#resetLocalConfigButton").addEventListener("click", resetLocalConfig);
  $("#rememberLastFolder").addEventListener("change", async (event) => {
    try { await api("/api/settings", { method: "PUT", body: JSON.stringify({ remember_last: event.target.checked }) }); }
    catch (error) { toast("设置保存失败", error.message, "error"); }
  });
}
function bindEvents() {
  bindWelcomeEvents();
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => activateSection(button.dataset.section)));
  $("#themeToggle").addEventListener("click", togglePanelTheme);
  $("#selectFolderButton").addEventListener("click", selectBlogFolder);
  $("#openFolderButton").addEventListener("click", openBlogFolder);
  $("#pathDisplay").addEventListener("click", openBlogFolder);
  $("#siteForm").addEventListener("submit", saveSiteConfig);
  $("#themeForm").addEventListener("submit", saveThemeConfig);
  $("#saveSiteButton").addEventListener("click", saveSiteConfig);
  $("#saveThemeButton").addEventListener("click", saveThemeConfig);
  $$("#siteModeSwitch button").forEach((button) => button.addEventListener("click", () => setConfigMode("site", button.dataset.mode)));
  $$("#themeModeSwitch button").forEach((button) => button.addEventListener("click", () => setConfigMode("theme", button.dataset.mode)));
  $("#siteRawYaml").addEventListener("input", () => { state.site.rawDirty = true; markDirty("site"); });
  $("#themeRawYaml").addEventListener("input", () => { state.theme.rawDirty = true; markDirty("theme"); });
  $("#siteConfigSearch").addEventListener("input", (event) => { state.site.searchTerm = event.target.value; applyConfigSearch("site"); });
  $("#themeConfigSearch").addEventListener("input", (event) => { state.theme.searchTerm = event.target.value; applyConfigSearch("theme"); });

  $("#addMenuItemButton").addEventListener("click", () => {
    state.theme.menuItems.push({ name: "新页面", url: "/", icon: "fas fa-link", extra: [] });
    state.theme.menuDirty = true;
    markDirty("theme");
    renderMenuItems();
  });
  $("#addSocialItemButton").addEventListener("click", () => {
    state.theme.socialItems.push({ icon: "fab fa-github", url: "https://github.com/", description: "Github", color: "#24292e" });
    state.theme.socialDirty = true;
    markDirty("theme");
    renderSocialItems();
  });

  $("#deployButton").addEventListener("click", requestDeploy);
  $("#previewButton").addEventListener("click", requestPreview);
  $("#forceGenerateButton").addEventListener("click", forceGenerate);
  $("#stopPreviewButton").addEventListener("click", () => stopPreview());
  $("#previewPort").addEventListener("change", () => checkPreviewPort(true));
  $("#useSuggestedPortButton").addEventListener("click", useSuggestedPreviewPort);
  $("#previewPort").addEventListener("input", () => {
    clearTimeout(checkPreviewPort.timer);
    checkPreviewPort.timer = setTimeout(() => checkPreviewPort(false), 450);
  });
  $("#historyLogButton").addEventListener("click", openLogHistory);
  $("#copyLogButton").addEventListener("click", copyLog);
  $("#clearLogButton").addEventListener("click", clearLog);
  $("#closeLogHistoryButton").addEventListener("click", closeLogHistory);
  $("#closeLogHistoryFooterButton").addEventListener("click", closeLogHistory);
  $("#loadMoreLogsButton").addEventListener("click", () => loadLogHistory(false));
  $("#downloadLogsButton").addEventListener("click", downloadLogHistory);
  $("#clearHistoryLogsButton").addEventListener("click", clearPersistentLogs);
  $("#logHistoryDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeLogHistory(); });
  $("#collapseLogButton").addEventListener("click", () => {
    const collapsed = $("#logPanel").classList.toggle("collapsed");
    $(".workspace").classList.toggle("log-collapsed", collapsed);
  });

  $("#refreshPostsButton").addEventListener("click", () => { setPostSelectionMode(false); loadPosts(); });
  $("#newPostButton").addEventListener("click", () => { setPostSelectionMode(false); $("#newPostForm").reset(); $("#newPostFolderCustomField").classList.add("hidden"); $("#newPostDialog").showModal(); });
  $("#cancelNewPostButton").addEventListener("click", (event) => { event.preventDefault(); closeNewPostDialog(); });
  $("#newPostDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeNewPostDialog(); });
  $("#newPostFolder").addEventListener("change", () => {
    const custom = $("#newPostFolder").value === "__new__";
    $("#newPostFolderCustomField").classList.toggle("hidden", !custom);
    if (custom) $("#newPostFolderCustom").focus();
  });
  $("#refreshPostTreeButton").addEventListener("click", () => { setPostSelectionMode(false); loadPosts(); });  $("#newPostForm").addEventListener("submit", createPost);
  $("#postSearch").addEventListener("input", renderPosts);
  $("#checkFrontmatterButton").addEventListener("click", handleFrontmatterCheck);
  $("#clearPostSelectionButton").addEventListener("click", clearPostSelection);
  $("#cleanTrashButton").addEventListener("click", cleanPostTrash);
  $("#postSelectAll").addEventListener("change", () => {
    const visible = state.postSelection.visiblePaths || [];
    if ($("#postSelectAll").checked) visible.forEach((path) => state.postSelection.selected.add(path));
    else visible.forEach((path) => state.postSelection.selected.delete(path));
    renderPosts();
  });
  $("#openFrontmatterButton").addEventListener("click", () => { setPostSelectionMode(false); openFrontmatterEditor(); });
  $("#closeFrontmatterButton").addEventListener("click", closeFrontmatterEditor);
  $("#cancelFrontmatterButton").addEventListener("click", closeFrontmatterEditor);
  $("#saveFrontmatterButton").addEventListener("click", saveFrontmatter);
  $("#addFrontmatterPropertyButton").addEventListener("click", addFrontmatterProperty);
  $("#frontmatterSearch").addEventListener("input", renderFrontmatterPostList);
  $("#frontmatterDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeFrontmatterEditor(); });
  $("#closeCoverButton").addEventListener("click", closeCoverDialog);
  $("#cancelCoverButton").addEventListener("click", closeCoverDialog);
  $("#confirmCoverButton").addEventListener("click", confirmCover);
  $("#removeCoverButton").addEventListener("click", removeCover);
  $("#uploadCoverButton").addEventListener("click", () => $("#coverFileInput").click());
  $("#coverFileInput").addEventListener("change", () => uploadCoverImage($("#coverFileInput").files?.[0]));
  $("#addCoverUrlButton").addEventListener("click", addCoverFromUrl);
  $("#coverDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeCoverDialog(); });
  $("#closeConfigImageButton").addEventListener("click", closeConfigImageDialog);
  $("#cancelConfigImageButton").addEventListener("click", closeConfigImageDialog);
  $("#confirmConfigImageButton").addEventListener("click", confirmConfigImage);
  $("#uploadConfigImageButton").addEventListener("click", () => $("#configImageFileInput").click());
  $("#configImageFileInput").addEventListener("change", () => uploadConfigImage($("#configImageFileInput").files?.[0]));
  $("#addConfigImageUrlButton").addEventListener("click", addConfigImageFromUrl);
  $("#configImageDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeConfigImageDialog(); });
  $("#configImageDialog").addEventListener("click", (event) => { if (event.target === $("#configImageDialog")) closeConfigImageDialog(); });
  $("#refreshImagesButton").addEventListener("click", () => loadImages());
  $("#openImagesFolderButton").addEventListener("click", () => openImageFolder(""));
  $("#imageSearch").addEventListener("input", renderImages);
  $("#uploadImagesButton").addEventListener("click", () => $("#imageFileInput").click());
  $("#imageFileInput").addEventListener("change", () => {
    const files = $("#imageFileInput").files;
    $("#imageFileInput").value = "";
    if (files?.length) uploadImagesFromPicker(files);
  });
  bindImageDropZone({
    zone: $("#imageDropZone"),
    overlay: $("#imageDropOverlay"),
    progress: $("#imageDropProgress"),
    extensions: DROP_IMAGE_EXTENSIONS,
    onFiles: handleImageDrop,
    noun: "张图片",
  });
  bindImageDropZone({
    zone: $("#coverLibraryDropZone"),
    overlay: $("#coverDropOverlay"),
    progress: $("#coverDropProgress"),
    extensions: DROP_COVER_EXTENSIONS,
    onFiles: handleCoverDrop,
    noun: "张封面图片",
  });
  $("#closeImageDialogButton").addEventListener("click", () => $("#imageDialog").close());
  $("#imageDialog").addEventListener("click", (event) => { if (event.target === $("#imageDialog")) { resetImageViewer(); $("#imageDialog").close(); } });

  $("#imageZoomIn").addEventListener("click", () => zoomImageView(0.2));
  $("#imageZoomOut").addEventListener("click", () => zoomImageView(-0.2));
  $("#imageReset").addEventListener("click", resetImageViewer);
  $("#imageRotateLeft").addEventListener("click", () => rotateImageView(-90));
  $("#imageRotateRight").addEventListener("click", () => rotateImageView(90));
  $("#imageNameText").addEventListener("dblclick", enterImageRenameMode);
  $("#imageNameInput").addEventListener("keydown", async (event) => {
    if (event.key === "Enter") { event.preventDefault(); await saveInlineImageRename(false); }
    else if (event.key === "Escape") { event.preventDefault(); cancelImageRename(); }
  });
  $("#imageNameInput").addEventListener("blur", () => { if (state.imageViewer.renaming) saveInlineImageRename(false); });
  $("#imageViewport").addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomImageView(event.deltaY < 0 ? 0.12 : -0.12);
  }, { passive: false });
  $("#imageViewport").addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.imageViewer.renaming) return;
    const viewer = state.imageViewer;
    viewer.dragging = true;
    viewer.startX = event.clientX;
    viewer.startY = event.clientY;
    viewer.originX = viewer.x;
    viewer.originY = viewer.y;
    $("#imageViewport").setPointerCapture(event.pointerId);
  });
  $("#imageViewport").addEventListener("pointermove", (event) => {
    const viewer = state.imageViewer;
    if (!viewer.dragging) return;
    viewer.x = viewer.originX + event.clientX - viewer.startX;
    viewer.y = viewer.originY + event.clientY - viewer.startY;
    applyImageTransform();
  });
  $("#imageViewport").addEventListener("pointerup", (event) => {
    state.imageViewer.dragging = false;
    try { $("#imageViewport").releasePointerCapture(event.pointerId); } catch (_error) { }
  });
  $("#closeImageDialogButton").addEventListener("click", () => {
    resetImageViewer();
    $("#imageDialog").close();
  });

  $("#closeMarkdownButton").addEventListener("click", closeMarkdownEditor);
  $("#saveMarkdownButton").addEventListener("click", saveMarkdownPost);
  $("#markdownSource").addEventListener("input", () => {
    state.editor.content = $("#markdownSource").value;
    state.editor.dirty = state.editor.content !== state.editor.original;
    $("#markdownStatus").textContent = state.editor.dirty ? "未保存" : "已加载";
    $("#markdownStatus").className = `markdown-status ${state.editor.dirty ? "dirty" : ""}`;
    // 不再在 composing 时直接 return：那样高亮层会整段停止更新，
    // 而 textarea 文字是透明的，用户会看不到正在输入的拼音/候选字。
    refreshMarkdownEditorView();
  });
  $("#markdownSource").addEventListener("compositionstart", () => {
    state.editor.composing = true;
    clearTimeout(state.editor.renderTimer);
  });
  $("#markdownSource").addEventListener("compositionend", () => {
    state.editor.composing = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!state.editor.composing) refreshMarkdownEditorView();
      });
    });
  });
  // composing 只在 compositionend 里清除；若该事件丢失（系统 IME 异常、
  // 合成中途关闭对话框），标志会永久为真并让编辑器表现异常，因此在失焦和
  // 关闭编辑器时兜底复位。
  $("#markdownSource").addEventListener("blur", () => { state.editor.composing = false; });
  $("#markdownSource").addEventListener("scroll", syncMarkdownScroll);
  $("#markdownSource").addEventListener("keydown", (event) => {
    if (event.isComposing || state.editor.composing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") { event.preventDefault(); wrapMarkdownSelection("**"); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") { event.preventDefault(); wrapMarkdownSelection("*"); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); wrapMarkdownSelection("[", "](https://)"); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveMarkdownPost(); }
    else if (event.key === "Tab") {
      event.preventDefault();
      const input = $("#markdownSource");
      input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  $("#markdownResizer").addEventListener("pointerdown", (event) => {
    const workspace = $("#markdownWorkspace");
    const rect = workspace.getBoundingClientRect();
    const onMove = (moveEvent) => {
      const percent = Math.min(78, Math.max(24, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      workspace.style.setProperty("--markdown-split", `${percent}%`);
      $("#markdownResizer").classList.add("dragging");
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      $("#markdownResizer").classList.remove("dragging");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    event.preventDefault();
  });
  $("#autoDeployLocalOnly").addEventListener("change", updateAutodeployMode);
  $("#autoDeployThemeSource").addEventListener("change", applyThemeSourceSelection);
  $("#progressThemeSource").addEventListener("change", () => {
    const source = $("#progressThemeSource").value;
    if (source === "__skip__") {
      state.autoDeploy.skipTheme = true;
      return;
    }
    if (source === "__current__") {
      state.autoDeploy.skipTheme = false;
      return;
    }
    state.autoDeploy.skipTheme = false;
    $("#autoDeployThemeSource").value = source;
    applyThemeSourceSelection();
  });
  $("#autoDeployThemeRepo").addEventListener("input", () => {
    if (!state.autoDeploy.settingRepo) $("#autoDeployThemeSource").value = "custom";
  });
  $("#autoDeployUrl").addEventListener("input", () => {
    clearTimeout(inferRepoFromSiteUrl.timer);
    inferRepoFromSiteUrl.timer = setTimeout(inferRepoFromSiteUrl, 350);
  });
  $("#autoDeployRepo").addEventListener("input", () => {
    if (!state.autoDeploy.settingRepo) state.autoDeploy.repoManual = Boolean(document.getElementById("autoDeployRepo").value.trim());
  });
  $("#autoDeployButton").addEventListener("click", openAutodeployDialog);
  $("#autoDeploySelectFolder").addEventListener("click", selectAutodeployFolder);
  $("#closeAutoDeployDialog").addEventListener("click", () => $("#autodeployDialog").close());
  $("#startAutoDeployButton").addEventListener("click", startAutodeploy);
  $("#cancelAutodeployButton").addEventListener("click", cancelAutodeployProgress);
  $("#retryAutodeployButton").addEventListener("click", retryAutodeployFromProgress);
  $("#repairDependenciesButton").addEventListener("click", repairAutodeployDependencies);
  $("#openThemeFolderButton").addEventListener("click", openAutodeployThemeFolder);
  $("#repairPreviewDependenciesButton").addEventListener("click", repairPreviewDependencies);
  $("#previewAfterDeployButton").addEventListener("click", previewAfterAutodeploy);
  $("#viewProgressLogButton").addEventListener("click", () => { const log = $("#progressLog"); log.scrollTop = log.scrollHeight; });
  $("#returnFromProgressButton").addEventListener("click", async () => {
    $("#autodeployProgressDialog").close();
    await loadStatus({ attachPreview: false });
    await enterWorkspace();
    activateSection("operations");
  });
  $("#autodeployProgressDialog").addEventListener("cancel", (event) => event.preventDefault());

  $("#exitButton").addEventListener("click", () => {
    if (hasUnsavedChanges() && !window.confirm("有未保存的配置修改，确定退出吗？未保存内容将丢失。")) return;
    $("#exitDialog").showModal();
  });
  $("#confirmExitButton").addEventListener("click", async (event) => {
    event.preventDefault();
    state.allowUnload = true;
    $("#exitDialog").close();
    toast("正在清理相关进程", "停止预览、部署任务并关闭应用窗口...", "info", 2500);
    try { await api("/api/app/exit", { method: "POST", body: "{}" }); } catch (_error) { /* server may close first */ }
    window.setTimeout(() => window.close(), 650);
  });
  $("#deployAnywayButton").addEventListener("click", async (event) => {
    event.preventDefault();
    $("#unsavedDialog").close();
    state.pendingDeploy = false;
    await startCommand("deploy");
  });
  window.addEventListener("beforeunload", (event) => {
    if (hasUnsavedChanges() && !state.allowUnload) {
      event.preventDefault();
      event.returnValue = "";
      return "";
    }
    closeEventSource();
    if (!state.allowUnload) {
      navigator.sendBeacon("/api/client/goodbye", new Blob([JSON.stringify({ reason: "window-close" })], { type: "application/json" }));
    }
  });
}

// 拖到落区以外的地方时，阻止浏览器直接打开该文件
function bindGlobalDropGuard() {
  ["dragover", "drop"].forEach((type) => {
    document.addEventListener(type, (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
    });
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    clearAllDropHighlights();
  });
  // 拖拽以任何方式结束时（含按 Esc 取消、拖到窗口外松开）统一复位，避免高亮卡住
  window.addEventListener("dragend", clearAllDropHighlights);
  window.addEventListener("blur", clearAllDropHighlights);
}

function clearAllDropHighlights() {
  document.body.classList.remove("drop-in-progress");
  $$(".drop-zone.drop-active").forEach((zone) => zone.classList.remove("drop-active"));
  $$(".drop-overlay.visible").forEach((overlay) => overlay.classList.remove("visible"));
}

// 心跳必须无条件注册：之前只在 loadStatus() 成功后注册，一旦首次状态请求失败，
// 后端就再也收不到心跳，会在看门狗超时后自行退出（连带杀掉正在跑的任务）。
function startClientHeartbeat() {
  const ping = () => api("/api/client/ping", { method: "POST", body: "{}" }).catch(() => {});
  ping();
  setInterval(ping, 3000);
  // 窗口重新可见/获得焦点时立刻补一次心跳：后台标签会被浏览器节流到约 1 次/分钟，
  // 系统休眠唤醒后也需要尽快刷新 last_seen，避免看门狗误判。
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
  window.addEventListener("focus", ping);
  window.addEventListener("pageshow", ping);
}

async function init() {
  initPanelTheme();
  updateHighlightTheme();
  bindGlobalDropGuard();
  const savedPort = localStorage.getItem("blog-manager-preview-port") || "4000";
  $("#previewPort").value = savedPort;
  $(".preview-card .command-line").innerHTML = previewCommandMarkup(savedPort);
  bindEvents();
  startClientHeartbeat();
  try {
    await loadStatus({ attachPreview: true });
    if (state.status?.cleanup_warning?.failed_browsers?.length) {
      const failed = state.status.cleanup_warning.failed_browsers.join(", ");
      toast("上次退出有进程未清理", `残留浏览器 PID：${failed}。可手动执行 taskkill /PID <pid> /T /F。`, "warning", 12000);
    }
  } catch (error) {
    $("#serverDot").className = "status-dot error";
    $("#serverLabel").textContent = "服务连接失败";
    toast("控制服务不可用", error.message, "error", 8000);
  }
  if (!state.status || state.status.show_welcome) {
    showWelcomeScreen();
    if (state.status?.first_run) showFirstRunGuide();
    return;
  }
  await enterWorkspace();
}

document.addEventListener("DOMContentLoaded", init);







































































