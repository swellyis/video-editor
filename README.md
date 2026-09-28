# Video Editor: installable PWA

A browser video editor for YouTube videos and Shorts. It runs entirely on your device, works offline once installed, and saves your projects automatically, including the video files.

The app is plain static files (HTML, CSS and ES modules). There's no build step. You can host the folder on any static host that serves HTTPS.

## Features
- **Timeline.** Whole-sequence playback with a playhead. Scrub on the ruler, zoom (buttons, slider, Ctrl+wheel, `+`/`-`/`0`), and use the separate **Video / Text / Music** tracks. Clip widths match their durations. Drag clips to reorder them and drag their edges to trim. Snapping and markers are included. Touch works too: tap an item to select it, then drag it or its edges.
- **Edit.** Split at the playhead (`S`), duplicate, delete, and ripple (text, music and markers after an edit shift with it). Undo/redo covers every edit (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl+Y).
- **Per clip:** trim, speed from 0.25× to 4× (audio keeps its pitch in the export), volume up to 200%, mute, audio fade in/out, transition in (cut, crossfade, fade to black), fit, zoom/pan crop, rotate, flip, Ken Burns motion, color (brightness, contrast, saturation, warmth, vignette) and presets (Warm, Cool, B&W, Vintage, Vivid, Dramatic, Golden hour).
- **Global look:** aspect ratio (Original, 16:9, 9:16 Shorts, 1:1, 4:5), fit, background (black, white, custom color, blurred video), a global color grade, an end fade, and a logo/watermark with position, size and opacity.
- **Image clips** (JPG/PNG/WebP) for title cards, with an adjustable duration.
- **Text layers:** as many as you want. Each one has its own text, start/end, position (drag it on the preview or use presets), size, width, color, style (Clean, Band, Box, Outline), font (bundled IBM Plex family), alignment, and fade in/out.
- **Music tracks:** trim, offset, volume, fade in/out, and optional auto-ducking under clip audio. The timeline shows a waveform.
- **Export:**
  - Settings: 720p, 1080p or 4K; 24, 30 or 60 fps; three quality levels; MP4 or WebM. The file extension always matches the container.
  - A progress bar shows the ETA and render speed, and you can cancel.
  - **Fast engine:** WebCodecs through the vendored [Mediabunny](https://mediabunny.dev) library (MPL-2.0). It decodes and encodes frame by frame, so it isn't tied to real time and audio/video sync is frame-accurate.
  - **Fallback engine:** a real-time canvas + MediaRecorder recording. It prefers MP4 when the browser supports it and falls back to WebM.
- **Thumbnail maker:** pick a frame, add a headline, a small line and an accent color, then download a 1280×720 JPG (kept under 2 MB).
- **YouTube details:** title, description and tags with character counters. Chapters are generated from markers (or clip names) using YouTube's rules (starts at 00:00, at least 3 chapters, each at least 10 s). There are copy buttons.
- **Projects:** the project and its media blobs autosave to IndexedDB. The project list lets you create, open, rename, duplicate and delete. You can export or import a project as JSON, with the media optionally embedded; media that wasn't embedded can be relinked.
- **PWA:**
  - A real manifest with icons, including maskable and Apple touch icons.
  - A service worker that caches the app shell for offline use under a versioned cache.
  - Self-hosted fonts.
  - An install button (`beforeinstallprompt`) with iOS and Android instructions.
  - An update banner when a new version is deployed.
  - An Android share target: share videos from the Gallery straight into the installed app.

## Browser support for export
Only Chrome was tested (desktop, plus a phone-sized viewport with touch emulation). The Safari and Firefox rows describe the expected behaviour, based on the capability detection built into the app.

| Browser | Engine used | Output |
|---|---|---|
| Chrome / Edge 94+ (desktop, Android) | WebCodecs (fast) | **MP4**: H.264 video. Audio is AAC where the browser has an AAC encoder (Windows, macOS, Android); on Linux Chrome it's **Opus-in-MP4** (YouTube accepts both) |
| Safari 17+ (macOS / iOS) | WebCodecs if both VideoEncoder and AudioEncoder exist, otherwise real-time MediaRecorder | MP4 |
| Firefox | WebCodecs (VP9/Opus WebM or H.264 MP4 when available), otherwise MediaRecorder | WebM (or MP4) |

The real-time fallback takes as long as the video itself. Keep the tab visible while it runs.

## Deploying
1. After editing any file, run `python3 bump-version.py`. It stamps `sw.js` with a content hash so installed copies pick up the update.
2. Upload the whole folder to any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages, and so on). Every path is relative, so a sub-path such as `/user.github.io/editor/` works too.
3. Open the URL on your phone:
   - **Android (Chrome):** tap *Install app*.
   - **iPhone (Safari):** Share → *Add to Home Screen*.

To test locally, run `python3 -m http.server 8000` in this folder and open http://localhost:8000. Service workers need HTTPS or localhost.

## Notes and limitations
- **ffmpeg.wasm isn't included.** The single-threaded core is about 30 MB. It encodes H.264 far slower than real time on phones, and it would need to be downloaded before the first offline use. The WebCodecs path already produces MP4 faster than real time, so ffmpeg.wasm added little except weight.
- **Storage:** exports are assembled in memory, so very long 4K exports need a lot of RAM. Media is stored in the browser's IndexedDB. Clearing site data deletes it. The app asks for persistent storage when you import media.
- **Speed changes:** in the export, audio for sped-up or slowed-down clips is time-stretched with WSOLA so the pitch stays the same. Preview uses the browser's own pitch preservation.
- **HEVC phone videos** play in the preview wherever the browser can play them. If WebCodecs can't decode them, export falls back to a slower frame-by-frame seek of a `<video>` element; output is identical, just slower.
- **Color grading** uses a small WebGL shader, so it looks the same in every browser.

## Licenses
- IBM Plex fonts: SIL Open Font License 1.1 (`fonts/OFL-LICENSE.txt`).
- Mediabunny: MPL-2.0 (`vendor/mediabunny-LICENSE.txt`).
