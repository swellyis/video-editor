# Video Editor: installable PWA

A browser video editor for YouTube videos and Shorts. It runs entirely on your device, works offline once installed, and saves your projects automatically, including the video files.

The app is plain static files (HTML, CSS and ES modules). There's no build step. You can host the folder on any static host that serves HTTPS.

## Features
- **Timeline.** Whole-sequence playback with a playhead. Scrub on the ruler, zoom (buttons, slider, Ctrl+wheel, `+`/`-`/`0`), and use the separate **Video / PiP / Text / Audio** tracks. Music and voiceover tracks show waveforms (video clips show thumbnails), and keyframes show as ◆ diamonds (click one to jump to it). Clip widths match their durations. Drag clips to reorder them and drag their edges to trim. Snapping and markers are included. Touch works too: tap an item to select it, then drag it or its edges.
- **Edit.** Split at the playhead (`S` or the Split button) on whichever item is selected: a main clip, text layer, music or voice track, or overlay. With nothing selected it splits the main track. Keyframe and Ken Burns motion carry on smoothly across the cut, and trims, fades and loops are divided correctly. Also duplicate, delete, and ripple (text, music and markers after an edit shift with it). Undo/redo covers every edit (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl+Y).
- **Per clip:** trim, speed from 0.25× to 4× (audio keeps its pitch in the export), volume up to 200%, mute, audio fade in/out, transition in (cut, crossfade, fade to black), fit, background override (blurred copy, black, white), zoom/pan crop, free rotation, 90° rotate, flip, opacity, Ken Burns motion, color (brightness, contrast, saturation, warmth, vignette) and presets (Warm, Cool, B&W, Vintage, Vivid, Dramatic, Golden hour).
- **Global look:** aspect ratio (Original, 16:9, 9:16 Shorts, 1:1, 4:5), fit, background (black, white, custom color, blurred video; switching to Shorts turns on the blurred fill automatically), a global color grade, an end fade, and a logo/watermark with position, size and opacity.
- **Image clips** (JPG/PNG/WebP/GIF/HEIC) for title cards, with an adjustable duration. Animated GIFs play in the preview and the export. HEIC/HEIF photos from iPhones are converted to JPEG on import: natively where the browser can decode them (Safari), otherwise with the bundled offline libheif decoder, which is only downloaded when needed.
- **Text layers:** as many as you want. Each one has its own text, start/end, position (drag it on the preview or use presets), size, scale, rotation, opacity, width, color, style (Clean, Band, Box, Outline), font (bundled IBM Plex family), alignment, and fade in/out.
- **Animated text presets:** Typewriter, Slide up, Pop and Word-by-word in-animations, plus Fade, Slide down, Pop out and Un-type out-animations, each with its own duration.
- **Keyframes:** animate position, scale, rotation and opacity of main clips, text layers and overlays. Easing can be Linear, Ease in, Ease out, Ease in/out or Hold. Add a keyframe with the ◆ button in the timeline toolbar (or Shift+K); it is only available while a clip, text layer or overlay is selected. Music and voice tracks have no keyframes; they use Volume, Fade in/out and ducking instead. After that, moving a slider or dragging the item on the preview sets a keyframe at the playhead automatically.
- **Picture-in-picture (PiP tab):** a second video or image over the main track. It has its own timing and trim, corner/center/full presets, position, size, scale, rotation, opacity, rounded corners, border, shadow, fades (the overlay's sound fades too), speed from 0.25× to 4× for video overlays (the sound keeps its pitch), and optional sound.
- **Chroma key (green screen)** for overlays: a key color (with "Pick from preview"), similarity, smoothness and spill suppression. It runs in a WebGL shader in both preview and export.
- **Voiceover:** record from the microphone straight into a voice track at the playhead. It shows a live level meter and a timer, and after each take you can listen back, then keep it, retake it or discard it. The video can play (muted) while you record. Music ducks under voice tracks automatically. Shortcut: `R` starts a 3-second countdown (press `R` or `Esc` again to cancel), and `R` during a take stops it. The microphone is released as soon as a take ends.
- **Music tracks:** trim, offset, volume, fade in/out, **Loop** (repeats the trimmed section until the video ends, or for a length you set; loop seams show on the timeline), and optional auto-ducking under clip audio and voiceovers. A track never ducks under itself. The timeline shows a waveform.
- **Starter templates:** Scripture verse card, Channel intro, Shorts quote (9:16), Lower-third name, and Sermon/devotional outline with section markers. Each one creates a new project or is inserted at the playhead, with generated backgrounds, animated text and slow-zoom keyframes. Everything stays editable.
- **Export:**
  - Settings: 720p, 1080p or 4K; 24, 30 or 60 fps; three quality levels; Auto, MP4 or WebM. **Auto** makes an MP4 where the browser can encode H.264 and otherwise a WebM (VP9/VP8), in both engines. The file extension always matches the container, and the file is named after the YouTube title, or the project name when that is empty (letters in any language, digits, dots and dashes are kept).
  - A progress bar shows the ETA and render speed, and you can cancel.
  - **Low memory use:** audio is decoded and mixed in 10-second chunks, and the output file streams to disk: straight into a file you pick ("Save straight to a file", Chrome/Edge desktop) or into the browser's private storage (OPFS) and then downloaded. Where neither is available the file is built in memory, and you get a warning before long exports on low-memory devices.
  - **Fast engine:** WebCodecs through the vendored [Mediabunny](https://mediabunny.dev) library (MPL-2.0). It decodes and encodes frame by frame, so it isn't tied to real time and audio/video sync is frame-accurate.
  - **Fallback engine:** a real-time canvas + MediaRecorder recording. It prefers MP4 when the browser supports it and falls back to WebM.
- **Thumbnail maker:** pick a frame, add a headline, a small line and an accent color, then download it as a JPG (kept under 2 MB, quality and size are lowered automatically if needed) or PNG. Choose the format: **YouTube 16:9 (1280×720)**, **Shorts 9:16 (1080×1920)** or **Square (1080×1080)**. It defaults to your project's aspect ratio. Text is laid out inside a safe area (shown as a dashed guide that is not saved in the image), shrinks to fit narrow Shorts widths, and the layout can be Left, Center, Right, Top band or Bottom band. Picture-in-picture overlays and the logo are included (each can be switched off). Files are named like `My-Video-thumbnail-shorts-1080x1920.jpg`.
- **Projects:** the project and its media blobs autosave to IndexedDB. A status label shows *Unsaved changes*, *Saving…*, *Saved hh:mm* or *Save failed – retrying*, and failed saves retry automatically. Older saved projects are migrated to the current schema when they open. The project list lets you create, open, rename, duplicate and delete. Switching projects saves pending edits first and frees the previous project's decoded media. You can export a project as a small `.vedit.json` (media stays on the device) or, with media included, as a `.vedit` file: a standard tar archive holding `project.json` plus each media file as raw bytes, streamed straight from storage (no base64, so it's about the size of the media). Older `.vedit.json` files with base64-embedded media still import. Media that wasn't embedded can be relinked.
- **PWA:**
  - A real manifest with icons, including maskable and Apple touch icons.
  - A service worker that caches the app shell for offline use under a versioned cache.
  - Self-hosted fonts.
  - An install button (`beforeinstallprompt`) with iOS, Android and desktop instructions. It's never shown when the app already runs installed (display-mode standalone, fullscreen, minimal-ui or window-controls-overlay, iOS `navigator.standalone`, or an `android-app://` referrer), and it's decided before first paint so it can't flash. The `appinstalled` event is remembered in localStorage, so a normal browser tab hides it too; Chrome/Edge's `navigator.getInstalledRelatedApps()` is used as an extra hint (the manifest lists this web app in `related_applications` with its `id`). Dismissing the browser's install prompt hides the button for 90 days; on iPhone the Add to Home Screen hint shows until you tap "Got it" once. If the app is uninstalled, the next `beforeinstallprompt` clears the flag and the button returns.
  - An update banner when a new version is deployed.
  - An Android share target: share videos from the Gallery straight into the installed app.

- **Keyboard:** shortcuts only act when you aren't typing, and a focused control keeps its own keys (arrows move a focused slider, Space presses a focused button). Every slider has a label and announces its current value. Press Tab to reach the timeline items: Enter selects, ←/→ nudges by a frame (Shift: 1 s; main clips swap with their neighbour), Alt+←/→ trims the end. Tabs support arrow keys.

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

Development checks (optional, needs Node 20+): `npm install`, then `npm run lint` (ESLint), `npm test` (unit tests in `tests/`), or `npm run predeploy` to lint, test and bump the version in one go. `node_modules` is git-ignored and isn't needed by the app.

## Notes and limitations
- **ffmpeg.wasm isn't included.** The single-threaded core is about 30 MB. It encodes H.264 far slower than real time on phones, and it would need to be downloaded before the first offline use. The WebCodecs path already produces MP4 faster than real time, so ffmpeg.wasm added little except weight.
- **Storage:** exports stream to disk where the browser supports OPFS writable streams or the File System Access save picker (Chrome/Edge, Android Chrome, recent Safari/Firefox for OPFS). Elsewhere they're assembled in memory. Media is stored in the browser's IndexedDB. Clearing site data deletes it. The app asks for persistent storage when you import media.
- **Speed changes:** in the export, audio for sped-up or slowed-down clips is time-stretched with WSOLA so the pitch stays the same. Preview uses the browser's own pitch preservation.
- **HEVC phone videos** play in the preview wherever the browser can play them. If WebCodecs can't decode them, export falls back to a slower frame-by-frame seek of a `<video>` element; output is identical, just slower.
- **Color grading** uses a small WebGL shader, so it looks the same in every browser. If WebGL is unavailable or the GPU context is lost, it falls back to canvas filters with an approximation of warmth, fade and vignette, and returns to WebGL when the context is restored.
- **Security:** the page ships a Content-Security-Policy (only the app's own scripts, plus wasm for the HEIC decoder). Imported project files are validated: settings are clamped and embedded media must be real base64 media data (URLs are never fetched). `window.__app` is only exposed on localhost or with `?debug`.
- **Several tabs:** cleanup of unused stored media is coordinated between open tabs (Web Locks + BroadcastChannel), so one tab never deletes media another tab still has in its undo history.
- **Voiceover** needs microphone permission and a secure context (HTTPS or localhost). Recordings are Opus/WebM in Chrome and Firefox and AAC/MP4 in Safari. Use headphones if you turn off "Silence timeline audio while recording".
- **Chroma key** works best on evenly lit, saturated green or blue backgrounds. Hair-fine detail is approximated with a soft edge.
- **Keyframe times** are relative to the item's start, so moving a clip or text moves its animation with it. Trimming an item's start shifts its keyframes, so the animation stays pinned to the same frames.
- **Long media:** waveforms and export audio are decoded by streaming, so an hour-long sermon isn't held in memory as raw audio. Preview audio plays from the media element.
- **Animated GIFs** are decoded with the browser's ImageDecoder where available (Chrome, Edge, Safari 17+ partly), otherwise with the bundled gifuct-js. Very large GIFs are downscaled to limit memory, and animation is capped at 60 s per clip by default. If a GIF can't be decoded, it's used as a still image and you're told.
- **HEIC:** only the primary image of a HEIC file is used. The wasm decoder is 1.4 MB and is precached for offline use.
- **Loop seams** in the preview are accurate to about a screen frame. In the export they're sample-accurate, with a short crossfade dip.

## Licenses
- IBM Plex fonts: SIL Open Font License 1.1 (`fonts/OFL-LICENSE.txt`).
- Mediabunny: MPL-2.0 (`vendor/mediabunny-LICENSE.txt`).
- libheif / libheif-js 1.23.2: LGPL-3.0 (`vendor/libheif/LICENSE-libheif.txt`, `vendor/libheif/LICENSE-libheif-js.txt`). It's loaded unmodified as a separate file, so you can replace it.
- gifuct-js 2.1.2: MIT (`vendor/gifuct-LICENSE.txt`).
