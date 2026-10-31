export function normalizeRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function clampRect(rect, bounds) {
  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  if (x < bounds.x) {
    w -= bounds.x - x;
    x = bounds.x;
  }
  if (y < bounds.y) {
    h -= bounds.y - y;
    y = bounds.y;
  }
  if (x + w > bounds.x + bounds.w) w = bounds.x + bounds.w - x;
  if (y + h > bounds.y + bounds.h) h = bounds.y + bounds.h - y;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function intersectsRect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function inkFor(hex) {
  const raw = hex.replace("#", "").trim();
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return "#ffffff";
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  return luminance > 160 ? "#14201b" : "#ffffff";
}

export function annotationBounds(ann) {
  if (!ann) return { x: 0, y: 0, w: 0, h: 0 };
  if (ann.type === "pen" || ann.type === "highlight") {
    if (!ann.points?.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = ann.points.map((p) => p.x);
    const ys = ann.points.map((p) => p.y);
    const pad = (ann.width || 4) / 2;
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(...xs) - minX + pad * 2,
      h: Math.max(...ys) - minY + pad * 2,
    };
  }
  if (ann.type === "line" || ann.type === "arrow") {
    const bounds = normalizeRect(ann.x1, ann.y1, ann.x2, ann.y2);
    const pad = (ann.width || 4) / 2;
    return { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  }
  if (ann.type === "step") {
    const r = ann.r || 18;
    return { x: ann.x - r, y: ann.y - r, w: r * 2, h: r * 2 };
  }
  if (ann.type === "text") {
    return { x: ann.x, y: ann.y, w: ann.w || 40, h: ann.h || ann.size || 24 };
  }
  return normalizeRect(ann.x, ann.y, ann.x + ann.w, ann.y + ann.h);
}

export function translateAnnotation(ann, dx, dy) {
  const next = structuredClone(ann);
  if (next.points) {
    next.points = next.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  if (typeof next.x === "number") next.x += dx;
  if (typeof next.y === "number") next.y += dy;
  if (typeof next.x1 === "number") {
    next.x1 += dx;
    next.y1 += dy;
    next.x2 += dx;
    next.y2 += dy;
  }
  return next;
}

function pointInRect(x, y, rect, pad = 0) {
  return x >= rect.x - pad && y >= rect.y - pad && x <= rect.x + rect.w + pad && y <= rect.y + rect.h + pad;
}

function hits(ann, x, y, tolerance) {
  if (ann.type === "pen" || ann.type === "highlight") {
    const reach = (ann.width || 4) / 2 + tolerance;
    const points = ann.points || [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= reach) return true;
    }
    return points.length === 1 && Math.hypot(x - points[0].x, y - points[0].y) <= reach;
  }
  if (ann.type === "line" || ann.type === "arrow") {
    const reach = (ann.width || 4) / 2 + tolerance;
    return distanceToSegment(x, y, ann.x1, ann.y1, ann.x2, ann.y2) <= reach;
  }
  if (ann.type === "ellipse") {
    const bounds = normalizeRect(ann.x, ann.y, ann.x + ann.w, ann.y + ann.h);
    const rx = Math.max(1, bounds.w / 2 + tolerance);
    const ry = Math.max(1, bounds.h / 2 + tolerance);
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (ann.type === "step") {
    const r = (ann.r || 18) + tolerance;
    return Math.hypot(x - ann.x, y - ann.y) <= r;
  }
  return pointInRect(x, y, annotationBounds(ann), tolerance);
}

export function hitTest(annotations, x, y, tolerance = 8) {
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    if (hits(annotations[i], x, y, tolerance)) return annotations[i];
  }
  return null;
}
