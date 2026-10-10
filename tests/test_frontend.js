"use strict";
// Regression tests execute the shipped frontend with minimal DOM doubles.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = { value: "" };
const preview = { innerHTML: "", querySelectorAll: () => [] };
const meta = { textContent: "" };
const rows = [];
const context = vm.createContext({
  console, URL, Set, Map, Date, clearTimeout, setTimeout,
  window: { markdownit: require("../static/vendor/markdown-it/markdown-it.min.js") },
  document: {
    addEventListener() {},
    querySelector(selector) {
      return { "#markdownSource": source, "#markdownPreview": preview, "#markdownPreviewMeta": meta }[selector];
    },
    querySelectorAll() { return rows; },
  },
});
vm.runInContext(fs.readFileSync("static/js/config-schema.js", "utf8"), context);
vm.runInContext(fs.readFileSync("static/js/app.js", "utf8"), context);
function run(code) { return vm.runInContext(code, context); }
source.value = "```html\n<img src=x onerror=alert(1)>\n```\n\n`<svg onload=alert(1)>`\n\n<script>alert(1)</script>";
run("renderMarkdownPreview()");
assert(!preview.innerHTML.includes("<img"));
assert(!preview.innerHTML.includes("<svg"));
assert(!preview.innerHTML.includes("<script>"));
assert(preview.innerHTML.includes("<pre>"));
assert(preview.innerHTML.includes("<code>"));
source.value = "```\n$x$\n```\n\n$x$";
run("renderMarkdownPreview()");
assert.equal((preview.innerHTML.match(/class="math-render"/g) || []).length, 1);
assert.equal(run('toDateInputValue("2026-10-09 12:34:56")'), "2026-10-09T12:34:56");
assert.equal(run('toDateInputValue("2026-10-09")'), "2026-10-09");
const controls = {
  name: { value: "date" }, type: { value: "date" },
  value: { value: "2027-02-03T11:22:33", dataset: { originalValue: "2026-10-09 12:34:56", originalDateValue: "2026-10-09T12:34:56" } },
};
rows.push({ querySelector(selector) { return controls[selector.match(/field="(\w+)"/)[1]]; } });
assert.equal(run("collectFrontmatterProperties()[0].value"), "2027-02-03 11:22:33");
controls.value.value = "2027-02-03";
assert.equal(run("collectFrontmatterProperties()[0].value"), "2027-02-03 12:34:56");
console.log("Frontend regressions passed: safe code rendering, math isolation, datetime display and collection.");
context.document.querySelector = (selector) => selector === "#coverDialog" ? { open: true } : null;
run(`
  state.cover.selectedValue = "/img/already-chosen.png";
  state.cover.relativePath = "article.md";
  state.cover.newImages = new Set();
  uploadImageFiles = async () => ({ images: [{relative_path: "new.png", name: "new.png"}] });
  renderCoverLibrary = () => {};
  setCoverPreview = () => {};
`);
run("handleCoverDrop([])").then(() => {
  assert.equal(run("state.cover.selectedValue"), "/img/already-chosen.png");
  assert(run('state.cover.newImages.has("new.png")'));
  console.log("Cover drop regression passed: upload preserves existing selection.");
}).catch((error) => { console.error(error); process.exitCode = 1; });
