const DB_NAME = "markshot";
const STORE = "captures";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export async function listCaptures() {
  const db = await openDb();
  const rows = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return rows.sort((a, b) => b.created - a.created);
}

export async function putCapture(record) {
  const db = await openDb();
  await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(record));
}

export async function deleteCapture(id) {
  const db = await openDb();
  await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
}
