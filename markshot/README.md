# Markshot

Markshot is a screen capture and markup tool. It grabs a still or a recording through the browser’s screen-sharing API, then lets you crop, annotate, and download the result. Captures you save stay in this browser.

## Run

From this directory:

```bash
python3 -m http.server 4173
```

Open [http://localhost:4173](http://localhost:4173). Use Capture, Record, Open, or Sample.

```bash
npm test
```

## What you can do

- Capture a screen, window, or tab, or open a local image
- Draw with pen, highlight, arrow, line, rectangle, ellipse, text, and numbered steps
- Blur a region and crop the frame
- Move, delete, undo, and redo marks
- Copy a PNG, download it, or keep it in the local library
- Record the shared screen, optionally mix in the microphone, then preview and download the clip

## Limits

Screen capture and recording depend on the browser picker. There is no system-wide hotkey, and Markshot cannot scroll another application’s window while capturing. Recordings use the format the browser provides, usually WebM.
