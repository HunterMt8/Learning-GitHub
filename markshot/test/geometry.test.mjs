import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationBounds,
  clampRect,
  distanceToSegment,
  hitTest,
  inkFor,
  intersectsRect,
  normalizeRect,
  translateAnnotation,
} from "../js/geometry.js";

test("normalizeRect flips inverted drags", () => {
  assert.deepEqual(normalizeRect(10, 8, 2, 20), { x: 2, y: 8, w: 8, h: 12 });
});

test("clampRect keeps the selection inside the image", () => {
  const clamped = clampRect({ x: -10, y: 5, w: 40, h: 100 }, { x: 0, y: 0, w: 50, h: 40 });
  assert.deepEqual(clamped, { x: 0, y: 5, w: 30, h: 35 });
});

test("distanceToSegment is zero on the segment and positive off it", () => {
  assert.equal(distanceToSegment(5, 0, 0, 0, 10, 0), 0);
  assert.equal(distanceToSegment(5, 4, 0, 0, 10, 0), 4);
  assert.equal(distanceToSegment(-2, 0, 0, 0, 10, 0), 2);
});

test("hitTest returns the topmost mark", () => {
  const marks = [
    { id: "box", type: "rect", x: 0, y: 0, w: 40, h: 40 },
    { id: "dot", type: "step", x: 10, y: 10, r: 8, n: 1 },
  ];
  assert.equal(hitTest(marks, 10, 10, 0).id, "dot");
  assert.equal(hitTest(marks, 30, 30, 0).id, "box");
  assert.equal(hitTest(marks, 80, 80, 0), null);
});

test("arrow hits use the shaft, not the whole bounding box", () => {
  const arrow = { id: "a", type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, width: 4 };
  assert.equal(hitTest([arrow], 50, 2, 4).id, "a");
  assert.equal(hitTest([arrow], 50, 30, 4), null);
});

test("translateAnnotation moves points and anchors", () => {
  const pen = translateAnnotation({ type: "pen", points: [{ x: 1, y: 2 }] }, 5, -1);
  assert.deepEqual(pen.points, [{ x: 6, y: 1 }]);
  const arrow = translateAnnotation({ type: "arrow", x1: 0, y1: 1, x2: 3, y2: 4 }, 2, 2);
  assert.deepEqual({ x1: arrow.x1, y1: arrow.y1, x2: arrow.x2, y2: arrow.y2 }, { x1: 2, y1: 3, x2: 5, y2: 6 });
});

test("annotation bounds and intersection support crop filtering", () => {
  const text = { type: "text", x: 10, y: 10, w: 20, h: 12 };
  assert.equal(intersectsRect(annotationBounds(text), { x: 0, y: 0, w: 15, h: 15 }), true);
  assert.equal(intersectsRect(annotationBounds(text), { x: 40, y: 40, w: 10, h: 10 }), false);
});

test("inkFor picks readable type on light and dark fills", () => {
  assert.equal(inkFor("#ffffff"), "#14201b");
  assert.equal(inkFor("#112233"), "#ffffff");
  assert.equal(inkFor("#e2f08a"), "#14201b");
});
