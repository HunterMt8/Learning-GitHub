import {
  annotationBounds,
  clampRect,
  hitTest,
  inkFor,
  intersectsRect,
  normalizeRect,
  translateAnnotation,
} from "./geometry.js";
import { canvasToBlob, deleteCapture, listCaptures, putCapture } from "./store.js";

const SWATCHES = ["#ff3355", "#e2f08a", "#ffffff", "#1b1b1b", "#3aa0ff", "#ffb020", "#b388ff", "#19c37d"];
const TOOLS = [
  ["select", "Select", "V", '<path d="M6 4l4.5 15 2.2-5.3L18 16z"/>'],
  ["pen", "Pen", "P", '<path d="M5 19.5 15.8 8.7l2.5 2.5L7.5 22H5zM14.5 7.4l2-2 2.5 2.5-2 2z"/>'],
  ["highlight", "Highlight", "H", '<path d="M5 16h9l5-5-4-4-5 5zM5 19h8"/>'],
  ["arrow", "Arrow", "A", '<path d="M5 17 17 5M11 5h6v6"/>'],
  ["line", "Line", "L", '<path d="M6 18 18 6"/>'],
  ["rect", "Rectangle", "R", '<rect x="5" y="6" width="14" height="12" rx="1"/>'],
  ["ellipse", "Ellipse", "E", '<ellipse cx="12" cy="12" rx="7" ry="5"/>'],
  ["text", "Text", "T", '<path d="M6 6h12M12 6v12"/>'],
  ["step", "Step", "N", '<circle cx="12" cy="12" r="7"/><path d="M12 9v6"/>'],
  ["blur", "Blur", "B", '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>'],
  ["crop", "Crop", "C", '<path d="M7 3v12a2 2 0 0 0 2 2h12M17 21V9a2 2 0 0 0-2-2H3"/>'],
];

const stage = document.querySelector("#stage");
const view = document.querySelector("#view");
const empty = document.querySelector("#empty");
const textInput = document.querySelector("#text-input");
const titleInput = document.querySelector("#title-input");
const cropBar = document.querySelector("#crop-bar");
const recordBar = document.querySelector("#record-bar");
const recordTime = document.querySelector("#record-time");
const toast = document.querySelector("#toast");
const dialog = document.querySelector("#dialog");
const dialogTitle = document.querySelector("#dialog-title");
const dialogBody = document.querySelector("#dialog-body");
const dialogOk = document.querySelector("#dialog-ok");
const library = document.querySelector("#library");
const colorInput = document.querySelector("#color-input");
const widthInput = document.querySelector("#width-input");
const widthLabel = document.querySelector("#width-label");
const metaSize = document.querySelector("#meta-size");
const metaZoom = document.querySelector("#meta-zoom");
const metaStep = document.querySelector("#meta-step");
const captureBtn = document.querySelector("#capture-btn");
const recordBtn = document.querySelector("#record-btn");
const undoBtn = document.querySelector("#undo-btn");
const redoBtn = document.querySelector("#redo-btn");
const fitBtn = document.querySelector("#fit-btn");
const copyBtn = document.querySelector("#copy-btn");
const saveBtn = document.querySelector("#save-btn");
const downloadBtn = document.querySelector("#download-btn");
const fileInput = document.querySelector("#file-input");
const toolRail = document.querySelector(".tools");
const swatchRow = document.querySelector("#swatches");

const viewCtx = view.getContext("2d");
const measureCtx = document.createElement("canvas").getContext("2d");

const state = {
  tool: "select",
  color: "#ff3355",
  width: 4,
  widthTouched: false,
  image: null,
  flat: document.createElement("canvas"),
  scratch: document.createElement("canvas"),
  annotations: [],
  draft: null,
  selectedId: null,
  editingId: null,
  nextStep: 1,
  undo: [],
  redo: [],
  dirty: false,
  libraryId: null,
  gesture: null,
  space: false,
  view: { scale: 1, ox: 0, oy: 0, userAdjusted: false },
  recorder: null,
  chunks: [],
  displayStream: null,
  micStream: null,
  audioCtx: null,
  recordTimer: 0,
  recordBase: 0,
  recordTickStart: 0,
  recordPaused: false,
  pendingBefore: null,
};

let pixelsDirty = true;
let toastTimer = 0;
let thumbUrls = [];
let checker = null;
let suppressTextBlur = false;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3400);
}

function ask(title, message, okLabel) {
  dialogTitle.textContent = title;
  dialogBody.replaceChildren();
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  dialogBody.append(paragraph);
  dialogOk.textContent = okLabel;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
}

function snapshot(withImage) {
  return {
    annotations: structuredClone(state.annotations),
    nextStep: state.nextStep,
    selectedId: state.selectedId,
    image: withImage && state.image ? copyCanvas(state.image) : null,
  };
}

function pushUndo(entry) {
  if (!entry) return;
  state.undo.push(entry);
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  state.dirty = true;
  updateChrome();
}

function restore(entry) {
  state.annotations = structuredClone(entry.annotations);
  state.nextStep = entry.nextStep;
  state.selectedId = entry.selectedId;
  state.draft = null;
  hideCropBar();
  if (entry.image) state.image = copyCanvas(entry.image);
  pixelsDirty = true;
  if (entry.image) fit();
  else render();
}

function undo() {
  if (!textInput.hidden) closeText(false);
  const prev = state.undo.pop();
  if (!prev) return;
  state.redo.push(snapshot(Boolean(prev.image)));
  restore(prev);
}

function redo() {
  if (!textInput.hidden) closeText(false);
  const next = state.redo.pop();
  if (!next) return;
  state.undo.push(snapshot(Boolean(next.image)));
  restore(next);
}

function copyCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

function fileSlug() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:-]/g, "");
  const name = (titleInput.value || "markshot")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${name || "markshot"}-${stamp}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  return ask("Discard this capture?", "Markup that is not saved in the library will be dropped.", "Discard");
}

async function setImage(canvas, options = {}) {
  if (!(await confirmDiscard())) return false;
  state.image = canvas;
  state.annotations = structuredClone(options.annotations || []);
  state.nextStep = options.nextStep || 1;
  state.libraryId = options.libraryId || null;
  state.undo = [];
  state.redo = [];
  state.draft = null;
  state.selectedId = null;
  state.editingId = null;
  state.dirty = false;
  state.view.userAdjusted = false;
  state.pendingBefore = null;
  if (!textInput.hidden) textInput.hidden = true;
  hideCropBar();
  if (options.name) titleInput.value = options.name.replace(/\.[a-z0-9]+$/i, "");
  if (!state.widthTouched) {
    state.width = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 360));
    widthInput.value = String(state.width);
  }
  pixelsDirty = true;
  fit();
  return true;
}

function makeSample() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e7eee9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#17352c";
  ctx.fillRect(0, 0, 240, canvas.height);
  ctx.fillStyle = "#e2f08a";
  ctx.font = "700 22px sans-serif";
  ctx.fillText("Northwind", 28, 54);
  ctx.font = "16px sans-serif";
  ["Overview", "Pipeline", "Notes", "Calendar"].forEach((label, index) => {
    ctx.fillStyle = index === 0 ? "#e7eee9" : "#9fb5ab";
    ctx.fillText(label, 28, 120 + index * 42);
  });
  ctx.fillStyle = "#17352c";
  ctx.font = "700 36px sans-serif";
  ctx.fillText("Weekly review", 288, 86);
  ctx.font = "18px sans-serif";
  ctx.fillStyle = "#4d655c";
  ctx.fillText("Three deals moved forward. Two need a follow-up.", 288, 124);

  const cards = [
    ["Open deals", "18"],
    ["Won", "$42k"],
    ["Waiting", "5"],
  ];
  cards.forEach((card, index) => {
    const x = 288 + index * 210;
    roundRect(ctx, x, 170, 190, 110, 16);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.fillStyle = "#60756c";
    ctx.font = "16px sans-serif";
    ctx.fillText(card[0], x + 18, 210);
    ctx.fillStyle = "#17352c";
    ctx.font = "700 32px sans-serif";
    ctx.fillText(card[1], x + 18, 252);
  });

  roundRect(ctx, 288, 310, 620, 340, 16);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.fillStyle = "#17352c";
  ctx.font = "700 18px sans-serif";
  ctx.fillText("Pipeline", 312, 348);
  [80, 140, 110, 190, 150, 220].forEach((height, index) => {
    ctx.fillStyle = index === 5 ? "#17352c" : "#b7d36a";
    ctx.fillRect(330 + index * 90, 600 - height, 48, height);
  });

  roundRect(ctx, 940, 170, 290, 480, 16);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.fillStyle = "#17352c";
  ctx.font = "700 18px sans-serif";
  ctx.fillText("Follow-ups", 964, 210);
  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#4d655c";
  ["Send the revised quote", "Confirm Thursday's demo", "Ask for the security review"].forEach((line, index) => {
    ctx.fillText(line, 964, 270 + index * 64);
  });
  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit() {
  if (!state.image || stage.clientWidth < 2 || stage.clientHeight < 2) {
    render();
    return;
  }
  const pad = 56;
  const scale = Math.min(
    (stage.clientWidth - pad) / state.image.width,
    (stage.clientHeight - pad) / state.image.height,
  );
  state.view.scale = Math.max(0.05, Math.min(scale, 2));
  state.view.ox = (stage.clientWidth - state.image.width * state.view.scale) / 2;
  state.view.oy = (stage.clientHeight - state.image.height * state.view.scale) / 2;
  state.view.userAdjusted = false;
  render();
}

function eventToImage(event) {
  const rect = stage.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.view.ox) / state.view.scale,
    y: (event.clientY - rect.top - state.view.oy) / state.view.scale,
  };
}

function checkerPattern() {
  if (checker) return checker;
  const tile = document.createElement("canvas");
  tile.width = 24;
  tile.height = 24;
  const ctx = tile.getContext("2d");
  ctx.fillStyle = "#d5ddd8";
  ctx.fillRect(0, 0, 24, 24);
  ctx.fillStyle = "#f7faf8";
  ctx.fillRect(0, 0, 12, 12);
  ctx.fillRect(12, 12, 12, 12);
  checker = viewCtx.createPattern(tile, "repeat");
  return checker;
}

function drawArrow(ctx, ann) {
  const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
  const head = Math.max(14, ann.width * 4);
  ctx.strokeStyle = ann.color;
  ctx.fillStyle = ann.color;
  ctx.lineWidth = ann.width;
  ctx.beginPath();
  ctx.moveTo(ann.x1, ann.y1);
  ctx.lineTo(ann.x2 - Math.cos(angle) * head * 0.55, ann.y2 - Math.sin(angle) * head * 0.55);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ann.x2, ann.y2);
  ctx.lineTo(ann.x2 - head * Math.cos(angle - Math.PI / 7), ann.y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(ann.x2 - head * Math.cos(angle + Math.PI / 7), ann.y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx, ann) {
  ctx.fillStyle = ann.color;
  ctx.font = `600 ${ann.size}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ann.text.split("\n").forEach((line, index) => {
    ctx.fillText(line, ann.x, ann.y + index * ann.size * 1.25);
  });
}

function drawStep(ctx, ann) {
  ctx.beginPath();
  ctx.fillStyle = ann.color;
  ctx.arc(ann.x, ann.y, ann.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = inkFor(ann.color);
  ctx.font = `700 ${Math.round(ann.r)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(ann.n), ann.x, ann.y + 1);
}

function drawAnnotation(ctx, ann) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (ann.type === "pen" || ann.type === "highlight") {
    const points = ann.points || [];
    if (points.length > 1) {
      ctx.strokeStyle = ann.color;
      ctx.globalAlpha = ann.type === "highlight" ? 0.38 : 1;
      ctx.lineWidth = ann.type === "highlight" ? ann.width * 4 : ann.width;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.stroke();
    }
  } else if (ann.type === "line") {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.width;
    ctx.beginPath();
    ctx.moveTo(ann.x1, ann.y1);
    ctx.lineTo(ann.x2, ann.y2);
    ctx.stroke();
  } else if (ann.type === "arrow") {
    drawArrow(ctx, ann);
  } else if (ann.type === "rect" || ann.type === "ellipse") {
    const rect = normalizeRect(ann.x, ann.y, ann.x + ann.w, ann.y + ann.h);
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.width;
    ctx.beginPath();
    if (ann.type === "rect") ctx.rect(rect.x, rect.y, rect.w, rect.h);
    else ctx.ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(0.5, rect.w / 2), Math.max(0.5, rect.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (ann.type === "text") {
    drawText(ctx, ann);
  } else if (ann.type === "step") {
    drawStep(ctx, ann);
  }
  ctx.restore();
}

function drawBlur(ctx, ann) {
  const rect = normalizeRect(ann.x, ann.y, ann.x + ann.w, ann.y + ann.h);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(ctx.canvas.width - x, Math.round(rect.w));
  const h = Math.min(ctx.canvas.height - y, Math.round(rect.h));
  if (w < 2 || h < 2) return;
  const block = Math.max(8, Math.round(Math.min(w, h) / 14));
  const source = document.createElement("canvas");
  source.width = w;
  source.height = h;
  source.getContext("2d").drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(w / block));
  small.height = Math.max(1, Math.round(h / block));
  const smallCtx = small.getContext("2d");
  smallCtx.imageSmoothingEnabled = false;
  smallCtx.drawImage(source, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

function paintFlat() {
  const image = state.image;
  const flat = state.flat;
  flat.width = image.width;
  flat.height = image.height;
  const ctx = flat.getContext("2d");
  ctx.drawImage(image, 0, 0);
  state.annotations.forEach((ann) => {
    if (ann.id === state.editingId) return;
    if (ann.type === "blur") drawBlur(ctx, ann);
    else drawAnnotation(ctx, ann);
  });
}

function composeImage() {
  if (!state.image) return null;
  if (pixelsDirty) {
    paintFlat();
    pixelsDirty = false;
  }
  if (!state.draft || state.draft.type === "crop") return state.flat;
  const scratch = state.scratch;
  if (scratch.width !== state.flat.width || scratch.height !== state.flat.height) {
    scratch.width = state.flat.width;
    scratch.height = state.flat.height;
  }
  const ctx = scratch.getContext("2d");
  ctx.clearRect(0, 0, scratch.width, scratch.height);
  ctx.drawImage(state.flat, 0, 0);
  if (state.draft.type === "blur") drawBlur(ctx, state.draft);
  else drawAnnotation(ctx, state.draft);
  return scratch;
}

function drawCropShade(ctx, draft) {
  const rect = normalizeRect(draft.x, draft.y, draft.x + draft.w, draft.y + draft.h);
  ctx.save();
  ctx.fillStyle = "rgba(8, 14, 12, 0.55)";
  ctx.beginPath();
  ctx.rect(0, 0, state.image.width, state.image.height);
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "#e2f08a";
  ctx.lineWidth = 2 / state.view.scale;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawSelection(ctx) {
  const ann = state.annotations.find((item) => item.id === state.selectedId);
  if (!ann) return;
  const bounds = annotationBounds(ann);
  const pad = 4 / state.view.scale;
  ctx.save();
  ctx.strokeStyle = "#e2f08a";
  ctx.lineWidth = 1.5 / state.view.scale;
  ctx.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
  ctx.strokeRect(bounds.x - pad, bounds.y - pad, bounds.w + pad * 2, bounds.h + pad * 2);
  ctx.restore();
}

function render() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (view.width !== pixelWidth || view.height !== pixelHeight) {
    view.width = pixelWidth;
    view.height = pixelHeight;
  }
  viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  viewCtx.clearRect(0, 0, width, height);
  viewCtx.fillStyle = "#0c1210";
  viewCtx.fillRect(0, 0, width, height);
  const imageCanvas = composeImage();
  if (!textInput.hidden && textInput.dataset.x) {
    const x = Number(textInput.dataset.x);
    const y = Number(textInput.dataset.y);
    const size = Number(textInput.dataset.size);
    textInput.style.left = `${state.view.ox + x * state.view.scale}px`;
    textInput.style.top = `${state.view.oy + y * state.view.scale}px`;
    textInput.style.fontSize = `${size * state.view.scale}px`;
  }
  if (imageCanvas) {
    viewCtx.save();
    viewCtx.translate(state.view.ox, state.view.oy);
    viewCtx.scale(state.view.scale, state.view.scale);
    viewCtx.fillStyle = checkerPattern() || "#ffffff";
    viewCtx.fillRect(0, 0, state.image.width, state.image.height);
    viewCtx.drawImage(imageCanvas, 0, 0);
    if (state.draft?.type === "crop") drawCropShade(viewCtx, state.draft);
    drawSelection(viewCtx);
    viewCtx.restore();
  }
  updateChrome();
}

function updateChrome() {
  const ready = Boolean(state.image);
  undoBtn.disabled = state.undo.length === 0;
  redoBtn.disabled = state.redo.length === 0;
  copyBtn.disabled = !ready;
  saveBtn.disabled = !ready;
  downloadBtn.disabled = !ready;
  fitBtn.disabled = !ready;
  captureBtn.disabled = Boolean(state.recorder);
  recordBtn.textContent = state.recorder ? "Stop" : "Record";
  recordBtn.setAttribute("aria-pressed", String(Boolean(state.recorder)));
  empty.hidden = ready;
  metaSize.textContent = ready ? `${state.image.width} × ${state.image.height}` : "No capture";
  metaZoom.textContent = ready ? `${Math.round(state.view.scale * 100)}%` : "—";
  metaStep.textContent = String(state.nextStep);
  widthLabel.textContent = `${state.width}px`;
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.tool === state.tool));
  });
  document.querySelectorAll(".swatch").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.color === state.color));
  });
}

function updateCursor() {
  if (state.space) stage.dataset.cursor = "grab";
  else if (state.tool === "select" || state.tool === "text") stage.dataset.cursor = state.tool;
  else stage.dataset.cursor = "draw";
}

function setTool(tool) {
  if (!textInput.hidden) closeText(true);
  state.tool = tool;
  if (tool !== "crop" && state.draft?.type === "crop") {
    state.draft = null;
    hideCropBar();
  }
  updateCursor();
  render();
}

function hideCropBar() {
  cropBar.hidden = true;
}

function showCropBar() {
  cropBar.hidden = false;
}

function measureText(text, size) {
  measureCtx.font = `600 ${size}px sans-serif`;
  const lines = text.split("\n");
  const width = Math.max(8, ...lines.map((line) => measureCtx.measureText(line || " ").width));
  return { w: width, h: lines.length * size * 1.25 };
}

function openTextInput(point, existing) {
  if (!textInput.hidden) return;
  state.pendingBefore = snapshot(false);
  state.editingId = existing?.id || null;
  const size = existing?.size || Math.max(22, state.width * 6);
  textInput.value = existing?.text || "";
  textInput.hidden = false;
  textInput.style.left = `${state.view.ox + point.x * state.view.scale}px`;
  textInput.style.top = `${state.view.oy + point.y * state.view.scale}px`;
  textInput.style.fontSize = `${size * state.view.scale}px`;
  textInput.style.color = existing?.color || state.color;
  textInput.dataset.x = String(point.x);
  textInput.dataset.y = String(point.y);
  textInput.dataset.size = String(size);
  textInput.dataset.color = existing?.color || state.color;
  pixelsDirty = true;
  render();
  suppressTextBlur = true;
  textInput.focus();
  setTimeout(() => {
    suppressTextBlur = false;
  }, 400);
}

function closeText(commit) {
  if (textInput.hidden) return;
  const text = textInput.value.trim();
  textInput.hidden = true;
  const editingId = state.editingId;
  state.editingId = null;
  if (commit && text) {
    const size = Number(textInput.dataset.size);
    const color = textInput.dataset.color;
    const measured = measureText(text, size);
    if (editingId) {
      const ann = state.annotations.find((item) => item.id === editingId);
      if (ann) Object.assign(ann, { text, color, size, w: measured.w, h: measured.h });
    } else {
      state.annotations.push({
        id: crypto.randomUUID(),
        type: "text",
        x: Number(textInput.dataset.x),
        y: Number(textInput.dataset.y),
        text,
        color,
        size,
        w: measured.w,
        h: measured.h,
      });
    }
    pushUndo(state.pendingBefore);
  }
  state.pendingBefore = null;
  pixelsDirty = true;
  render();
}

function placeStep(point) {
  const before = snapshot(false);
  const radius = Math.max(16, Math.round(state.image.width / 55));
  const ann = {
    id: crypto.randomUUID(),
    type: "step",
    x: point.x,
    y: point.y,
    n: state.nextStep,
    r: radius,
    color: state.color,
  };
  state.annotations.push(ann);
  state.nextStep += 1;
  state.selectedId = ann.id;
  pushUndo(before);
  pixelsDirty = true;
  render();
}

function isSubstantial(draft) {
  if (draft.type === "pen" || draft.type === "highlight") return (draft.points || []).length > 1;
  if (draft.type === "line" || draft.type === "arrow") return Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 3;
  return Math.abs(draft.w) > 3 && Math.abs(draft.h) > 3;
}

function applyCrop() {
  if (!state.draft || state.draft.type !== "crop" || !state.image) return;
  const raw = normalizeRect(state.draft.x, state.draft.y, state.draft.x + state.draft.w, state.draft.y + state.draft.h);
  const rect = clampRect(raw, { x: 0, y: 0, w: state.image.width, h: state.image.height });
  if (rect.w < 8 || rect.h < 8) {
    showToast("Crop area is too small.");
    return;
  }
  const before = snapshot(true);
  const next = document.createElement("canvas");
  next.width = Math.max(1, Math.round(rect.w));
  next.height = Math.max(1, Math.round(rect.h));
  next.getContext("2d").drawImage(state.image, rect.x, rect.y, rect.w, rect.h, 0, 0, next.width, next.height);
  state.image = next;
  state.annotations = state.annotations
    .filter((ann) => intersectsRect(annotationBounds(ann), rect))
    .map((ann) => translateAnnotation(ann, -rect.x, -rect.y));
  state.draft = null;
  state.selectedId = null;
  hideCropBar();
  pushUndo(before);
  pixelsDirty = true;
  state.view.userAdjusted = false;
  fit();
}

function removeSelected() {
  if (!state.selectedId) return;
  const before = snapshot(false);
  const removed = state.annotations.find((ann) => ann.id === state.selectedId);
  state.annotations = state.annotations.filter((ann) => ann.id !== state.selectedId);
  if (removed?.type === "step") {
    const steps = state.annotations.filter((ann) => ann.type === "step");
    state.nextStep = steps.reduce((max, ann) => Math.max(max, ann.n), 0) + 1;
  }
  state.selectedId = null;
  pushUndo(before);
  pixelsDirty = true;
  render();
}

function onPointerDown(event) {
  if (event.target.closest("button, textarea")) return;
  if (!state.image) return;
  if (event.button === 1 || (event.button === 0 && state.space)) {
    state.gesture = {
      panning: true,
      x: event.clientX,
      y: event.clientY,
      ox: state.view.ox,
      oy: state.view.oy,
    };
    stage.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  const point = eventToImage(event);
  state.gesture = { id: event.pointerId, start: point, before: snapshot(false) };
  stage.setPointerCapture(event.pointerId);

  if (state.tool === "select") {
    const hit = hitTest(state.annotations, point.x, point.y, 10 / state.view.scale);
    state.selectedId = hit ? hit.id : null;
    if (hit) {
      state.gesture.move = true;
      state.gesture.origin = structuredClone(hit);
    }
    render();
    return;
  }
  if (state.tool === "text") {
    state.gesture.placeText = true;
    return;
  }
  if (state.tool === "step") {
    placeStep(point);
    state.gesture = null;
    return;
  }
  if (state.tool === "pen" || state.tool === "highlight") {
    state.draft = {
      id: crypto.randomUUID(),
      type: state.tool,
      points: [point],
      color: state.color,
      width: state.width,
    };
  } else if (state.tool === "line" || state.tool === "arrow") {
    state.draft = {
      id: crypto.randomUUID(),
      type: state.tool,
      x1: point.x,
      y1: point.y,
      x2: point.x,
      y2: point.y,
      color: state.color,
      width: state.width,
    };
  } else {
    state.draft = {
      id: crypto.randomUUID(),
      type: state.tool,
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
      color: state.color,
      width: state.width,
    };
    if (state.tool === "crop") hideCropBar();
  }
  render();
}

function onPointerMove(event) {
  const gesture = state.gesture;
  if (!gesture) return;
  if (gesture.panning) {
    state.view.ox = gesture.ox + (event.clientX - gesture.x);
    state.view.oy = gesture.oy + (event.clientY - gesture.y);
    state.view.userAdjusted = true;
    render();
    return;
  }
  const point = eventToImage(event);
  if (gesture.move) {
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    gesture.lastDx = dx;
    gesture.lastDy = dy;
    const index = state.annotations.findIndex((ann) => ann.id === state.selectedId);
    if (index >= 0) state.annotations[index] = translateAnnotation(gesture.origin, dx, dy);
    pixelsDirty = true;
    render();
    return;
  }
  if (!state.draft) return;
  if (state.draft.type === "pen" || state.draft.type === "highlight") {
    const last = state.draft.points.at(-1);
    if (Math.hypot(point.x - last.x, point.y - last.y) >= 0.8) state.draft.points.push(point);
  } else if (state.draft.type === "line" || state.draft.type === "arrow") {
    state.draft.x2 = point.x;
    state.draft.y2 = point.y;
  } else {
    state.draft.w = point.x - gesture.start.x;
    state.draft.h = point.y - gesture.start.y;
  }
  render();
}

function onPointerUp() {
  const gesture = state.gesture;
  const draft = state.draft;
  state.gesture = null;
  if (!gesture || gesture.panning) return;
  if (gesture.placeText) {
    openTextInput(gesture.start);
    return;
  }
  if (gesture.move) {
    if (Math.hypot(gesture.lastDx || 0, gesture.lastDy || 0) > 0.5) pushUndo(gesture.before);
    pixelsDirty = true;
    render();
    return;
  }
  if (!draft) return;
  if (draft.type === "crop") {
    const rect = normalizeRect(draft.x, draft.y, draft.x + draft.w, draft.y + draft.h);
    if (rect.w < 8 || rect.h < 8) {
      state.draft = null;
      hideCropBar();
    } else showCropBar();
    render();
    return;
  }
  if (!isSubstantial(draft)) {
    state.draft = null;
    render();
    return;
  }
  if (draft.type === "rect" || draft.type === "ellipse" || draft.type === "blur") {
    const rect = normalizeRect(draft.x, draft.y, draft.x + draft.w, draft.y + draft.h);
    Object.assign(draft, rect);
  }
  state.annotations.push(draft);
  state.selectedId = draft.id;
  state.draft = null;
  pushUndo(gesture.before);
  pixelsDirty = true;
  render();
}

function exportCanvas() {
  pixelsDirty = true;
  const base = composeImage();
  return base || state.flat;
}

async function copyImage() {
  if (!state.image) return;
  const blob = await canvasToBlob(exportCanvas());
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    showToast("Clipboard images are unavailable here. Download the PNG instead.");
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showToast("Copied the image.");
  } catch {
    showToast("The browser blocked clipboard access. Download the PNG instead.");
  }
}

async function downloadImage() {
  if (!state.image) return;
  const blob = await canvasToBlob(exportCanvas());
  downloadBlob(blob, `${fileSlug()}.png`);
}

function thumbnail(source) {
  const scale = Math.min(1, 360 / source.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function trimLibrary() {
  const rows = await listCaptures();
  await Promise.all(rows.slice(40).map((row) => deleteCapture(row.id)));
}

async function saveToLibrary() {
  if (!state.image) return;
  try {
    const flat = exportCanvas();
    const record = {
      id: state.libraryId || crypto.randomUUID(),
      kind: "image",
      name: titleInput.value.trim() || "Untitled capture",
      created: Date.now(),
      width: state.image.width,
      height: state.image.height,
      imageBlob: await canvasToBlob(state.image),
      annotations: structuredClone(state.annotations),
      nextStep: state.nextStep,
      thumbBlob: await canvasToBlob(thumbnail(flat), "image/jpeg", 0.82),
    };
    state.libraryId = record.id;
    await putCapture(record);
    await trimLibrary();
    state.dirty = false;
    updateChrome();
    await refreshLibrary();
    showToast("Saved in this browser.");
  } catch {
    showToast("Could not save in this browser.");
  }
}

function blobToCanvas(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable image"));
    };
    image.src = url;
  });
}

function showVideoDialog(blob) {
  const url = URL.createObjectURL(blob);
  const extension = blob.type.includes("mp4") ? "mp4" : "webm";
  dialogTitle.textContent = "Recording ready";
  dialogBody.replaceChildren();
  const video = document.createElement("video");
  video.className = "preview-video";
  video.controls = true;
  video.src = url;
  dialogBody.append(video);
  dialogOk.textContent = "Download";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "ok") downloadBlob(blob, `${fileSlug()}.${extension}`);
    URL.revokeObjectURL(url);
  }, { once: true });
  dialog.showModal();
}

async function refreshLibrary() {
  try {
    const rows = await listCaptures();
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    thumbUrls = [];
    library.replaceChildren();
    if (!rows.length) {
      const note = document.createElement("p");
      note.className = "empty-copy";
      note.textContent = "Saved captures stay in this browser.";
      library.append(note);
      return;
    }
    rows.forEach((row) => {
      const article = document.createElement("article");
      article.className = "shot";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "shot-open";
      if (row.thumbBlob) {
        const img = document.createElement("img");
        const url = URL.createObjectURL(row.thumbBlob);
        thumbUrls.push(url);
        img.src = url;
        img.alt = "";
        open.append(img);
      } else {
        const fallback = document.createElement("div");
        fallback.className = "shot-fallback";
        open.append(fallback);
      }
      const name = document.createElement("span");
      name.className = "shot-name";
      name.textContent = row.kind === "video" ? `${row.name} (video)` : row.name;
      open.append(name);
      open.addEventListener("click", () => loadCapture(row));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "shot-delete";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => removeCapture(row));
      article.append(open, remove);
      library.append(article);
    });
  } catch {
    library.textContent = "Library is unavailable in this browser.";
  }
}

async function loadCapture(row) {
  if (row.kind === "video") {
    showVideoDialog(row.blob);
    return;
  }
  try {
    const canvas = await blobToCanvas(row.imageBlob);
    await setImage(canvas, {
      name: row.name,
      annotations: row.annotations || [],
      nextStep: row.nextStep || 1,
      libraryId: row.id,
    });
  } catch {
    showToast("Could not open that capture.");
  }
}

async function removeCapture(row) {
  const ok = await ask("Delete this capture?", `"${row.name}" will be removed from this browser.`, "Delete");
  if (!ok) return;
  await deleteCapture(row.id);
  if (state.libraryId === row.id) state.libraryId = null;
  await refreshLibrary();
}

function frameFromStream(stream) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    const timeout = setTimeout(() => reject(new Error("The capture frame did not arrive.")), 5000);
    video.onloadeddata = async () => {
      try {
        await video.play();
        await new Promise((done) => {
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => done());
          else setTimeout(done, 80);
        });
        if (!video.videoWidth) throw new Error("empty frame");
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        clearTimeout(timeout);
        resolve(canvas);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    };
  });
}

async function captureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("This browser cannot capture the screen.");
    return;
  }
  if (!window.isSecureContext) {
    showToast("Screen capture needs HTTPS or localhost.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") showToast("Screen capture was canceled.");
    else showToast("Screen capture failed.");
    return;
  }
  try {
    const canvas = await frameFromStream(stream);
    const loaded = await setImage(canvas, { name: "Screen capture" });
    if (loaded) showToast("Captured. Mark it up, or press C to crop.");
  } catch {
    showToast("Could not read a frame from that share.");
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function pickMime() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return types.find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
}

function cleanupRecording() {
  state.displayStream?.getTracks().forEach((track) => track.stop());
  state.micStream?.getTracks().forEach((track) => track.stop());
  state.audioCtx?.close().catch(() => {});
  state.displayStream = null;
  state.micStream = null;
  state.audioCtx = null;
}

function updateRecordClock() {
  const running = state.recordPaused ? 0 : performance.now() - state.recordTickStart;
  const total = Math.floor((state.recordBase + running) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  recordTime.textContent = `${minutes}:${seconds}`;
  recordBar.hidden = false;
}

function stopRecording() {
  const recorder = state.recorder;
  if (!recorder || recorder.state === "inactive") return;
  recorder.stop();
}

async function finishRecording() {
  const chunks = state.chunks;
  const mime = state.recorder?.mimeType || chunks[0]?.type || "video/webm";
  clearInterval(state.recordTimer);
  state.recorder = null;
  state.chunks = [];
  cleanupRecording();
  recordBar.hidden = true;
  updateChrome();
  if (!chunks.length) {
    showToast("Recording was empty.");
    return;
  }
  const blob = new Blob(chunks, { type: mime });
  try {
    await putCapture({
      id: crypto.randomUUID(),
      kind: "video",
      name: titleInput.value.trim() || "Recording",
      created: Date.now(),
      blob,
      mime: blob.type,
    });
    await trimLibrary();
    await refreshLibrary();
  } catch {
    showToast("The clip is ready, but it could not be stored in the library.");
  }
  showVideoDialog(blob);
}

async function startRecording() {
  if (state.recorder) {
    stopRecording();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    showToast("This browser cannot record the screen.");
    return;
  }
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") showToast("Recording was canceled.");
    else showToast("Recording failed to start.");
    return;
  }
  state.displayStream = displayStream;
  let recordStream = displayStream;
  if (document.querySelector("#mic-toggle").checked) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(mic).connect(dest);
      if (displayStream.getAudioTracks().length) {
        audioCtx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks())).connect(dest);
      }
      recordStream = new MediaStream([...displayStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      state.micStream = mic;
      state.audioCtx = audioCtx;
    } catch {
      showToast("Microphone unavailable. Recording the screen only.");
    }
  }
  let recorder;
  try {
    const mime = pickMime();
    recorder = new MediaRecorder(recordStream, mime ? { mimeType: mime } : undefined);
  } catch {
    cleanupRecording();
    showToast("This browser could not start a recording.");
    return;
  }
  state.chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) state.chunks.push(event.data);
  };
  recorder.onstop = () => {
    finishRecording().catch(() => showToast("Could not finish the recording."));
  };
  displayStream.getVideoTracks()[0]?.addEventListener("ended", stopRecording);
  recorder.start(250);
  state.recorder = recorder;
  state.recordPaused = false;
  state.recordBase = 0;
  state.recordTickStart = performance.now();
  clearInterval(state.recordTimer);
  state.recordTimer = setInterval(updateRecordClock, 200);
  updateRecordClock();
  updateChrome();
}

function togglePause() {
  const recorder = state.recorder;
  if (!recorder) return;
  if (recorder.state === "recording" && typeof recorder.pause === "function") {
    recorder.pause();
    state.recordBase += performance.now() - state.recordTickStart;
    state.recordPaused = true;
    document.querySelector("#record-pause").textContent = "Resume";
  } else if (recorder.state === "paused") {
    recorder.resume();
    state.recordTickStart = performance.now();
    state.recordPaused = false;
    document.querySelector("#record-pause").textContent = "Pause";
  }
  updateRecordClock();
}

function openFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    setImage(canvas, { name: file.name });
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    showToast("That file is not an image Markshot can open.");
  };
  image.src = url;
}

function onKeyDown(event) {
  if (dialog.open) return;
  const typing = event.target.matches("input, textarea");
  if (event.key === "Escape") {
    if (!textInput.hidden) closeText(false);
    state.draft = null;
    hideCropBar();
    render();
    return;
  }
  if (typing) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "0") {
    event.preventDefault();
    state.view.userAdjusted = false;
    fit();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "s") {
    event.preventDefault();
    saveToLibrary();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removeSelected();
    return;
  }
  if (event.key === "Enter" && state.draft?.type === "crop") {
    event.preventDefault();
    applyCrop();
    return;
  }
  if (event.key === " ") {
    event.preventDefault();
    state.space = true;
    updateCursor();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tool = {
    v: "select", p: "pen", h: "highlight", a: "arrow", l: "line",
    r: "rect", e: "ellipse", t: "text", n: "step", b: "blur", c: "crop",
  }[key];
  if (tool) setTool(tool);
}

function buildTools() {
  TOOLS.forEach(([id, label, key, path]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool";
    button.dataset.tool = id;
    button.title = `${label} (${key})`;
    button.setAttribute("aria-label", `${label} (${key})`);
    button.setAttribute("aria-pressed", String(id === state.tool));
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    button.addEventListener("click", () => setTool(id));
    toolRail.append(button);
  });
  SWATCHES.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.dataset.color = color;
    button.style.background = color;
    button.setAttribute("aria-label", color);
    button.addEventListener("click", () => {
      state.color = color;
      colorInput.value = color;
      updateChrome();
    });
    swatchRow.append(button);
  });
}

buildTools();
updateCursor();
render();
refreshLibrary();

document.querySelector("#capture-btn").addEventListener("click", captureScreen);
document.querySelector("#empty-capture").addEventListener("click", captureScreen);
recordBtn.addEventListener("click", startRecording);
document.querySelector("#record-stop").addEventListener("click", stopRecording);
document.querySelector("#record-pause").addEventListener("click", togglePause);
document.querySelector("#open-btn").addEventListener("click", () => fileInput.click());
document.querySelector("#empty-open").addEventListener("click", () => fileInput.click());
document.querySelector("#sample-btn").addEventListener("click", () => setImage(makeSample(), { name: "Northwind weekly" }));
document.querySelector("#empty-sample").addEventListener("click", () => setImage(makeSample(), { name: "Northwind weekly" }));
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
fitBtn.addEventListener("click", () => {
  state.view.userAdjusted = false;
  fit();
});
copyBtn.addEventListener("click", copyImage);
saveBtn.addEventListener("click", saveToLibrary);
downloadBtn.addEventListener("click", downloadImage);
document.querySelector("#crop-apply").addEventListener("click", applyCrop);
document.querySelector("#crop-cancel").addEventListener("click", () => {
  state.draft = null;
  hideCropBar();
  render();
});
document.querySelector("#reset-step").addEventListener("click", () => {
  state.nextStep = 1;
  updateChrome();
});
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files || [];
  fileInput.value = "";
  openFile(file);
});
colorInput.addEventListener("input", () => {
  state.color = colorInput.value;
  updateChrome();
});
widthInput.addEventListener("input", () => {
  state.width = Number(widthInput.value);
  state.widthTouched = true;
  updateChrome();
});
textInput.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    closeText(false);
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    closeText(true);
  }
});
textInput.addEventListener("blur", () => {
  if (suppressTextBlur) {
    requestAnimationFrame(() => {
      if (!textInput.hidden) textInput.focus();
    });
    return;
  }
  closeText(true);
});
stage.addEventListener("pointerdown", onPointerDown);
stage.addEventListener("pointermove", onPointerMove);
stage.addEventListener("pointerup", onPointerUp);
stage.addEventListener("pointercancel", onPointerUp);
stage.addEventListener("dblclick", (event) => {
  if (!state.image || state.tool !== "select" || !textInput.hidden) return;
  const point = eventToImage(event);
  const hit = hitTest(state.annotations, point.x, point.y, 10 / state.view.scale);
  if (hit?.type === "text") openTextInput({ x: hit.x, y: hit.y }, hit);
});
stage.addEventListener("wheel", (event) => {
  if (!state.image) return;
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const before = state.view.scale;
  const next = Math.min(8, Math.max(0.05, before * (event.deltaY < 0 ? 1.08 : 0.92)));
  const ix = (px - state.view.ox) / before;
  const iy = (py - state.view.oy) / before;
  state.view.scale = next;
  state.view.ox = px - ix * next;
  state.view.oy = py - iy * next;
  state.view.userAdjusted = true;
  render();
}, { passive: false });
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", (event) => {
  if (event.key === " ") {
    state.space = false;
    updateCursor();
  }
});
window.addEventListener("blur", () => {
  state.space = false;
  updateCursor();
});
new ResizeObserver(() => {
  if (!state.image || state.view.userAdjusted) render();
  else fit();
}).observe(stage);
