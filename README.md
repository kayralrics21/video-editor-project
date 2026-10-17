# kayralrics.com - video

**Site:** `kayralrics.com - video`  
**Credit:** [kayralrics.net](https://kayralrics.net/)

A browser-based video editor with a local FFmpeg processing engine. The interface is in English and keeps imported media in the browser for ordinary editing. When the user chooses media conversion or an extended export profile, the selected render/source file is sent to the local Python server bound to loopback (`127.0.0.1`).

## Run on Fedora / Linux

1. Extract the ZIP archive.
2. Open a terminal in the `kayralrics.com-video` folder.
3. Start the app:

   ```bash
   chmod +x start.sh
   ./start.sh
   ```

4. Open the exact address printed in the terminal (usually `http://127.0.0.1:8080`).
5. Keep the terminal open while working; press `Ctrl+C` to stop the server.

Python 3 is required. The front-end does not require Node.js or Python packages. The server probes available FFmpeg formats and encoders at runtime. If port 8080 is occupied, it tries the next few ports and prints the actual address.

## Run on Windows

Double-click `start.bat`. Python 3 must be installed. Open the actual local URL shown in the terminal if your browser does not open automatically.

## Enable extended media support

Install FFmpeg using an appropriate package source for your operating system, then restart the app. On Fedora, availability depends on enabled repositories and their codec policies; check with:

```bash
ffmpeg -version
ffmpeg -muxers
ffmpeg -encoders
```

The export menu calls `/api/formats` and displays only the output profiles whose required muxer and encoders are present in the installed FFmpeg build. The list therefore changes across FFmpeg distributions. The current test environment exposed 41 tested profiles. Other installations may expose fewer or more of the codecs used by those profiles.

## Output formats

The local export menu supports the following profiles when required components exist:

- **Video:** MP4/H.264, MP4/HEVC, MP4/AV1, M4V, QuickTime MOV/H.264, MOV/ProRes, MKV/H.264, MKV/HEVC, MKV/AV1, MKV/FFV1 lossless, WebM/VP9, WebM/VP8, AVI/MPEG-4, AVI/Xvid, FLV, MPEG program stream, MPEG-TS, VOB, 3GP, 3G2, OGV/Theora, MXF, ASF/WMV, DV and NUT/FFV1.
- **Animation:** GIF, animated PNG (APNG), animated WebP. These formats do not include audio.
- **Audio-only:** MP3, M4A/AAC, AAC, WAV 16-bit PCM, WAV 24-bit PCM, FLAC, Ogg Vorbis, Opus, AIFF, AC-3, E-AC-3, WMA and ALAC.

The profile list is not a promise that every codec/container ever created is supported. A container can require specific codec combinations, and some FFmpeg distributions omit encoders because of build choices, licensing, or platform policies. Profiles are filtered against the actual local encoder/muxer list and are exercised by a final FFmpeg conversion step before the file is downloaded. Audio-only exports require an audio stream in the rendered timeline.

Without the local server, the editor offers only MP4/WebM profiles that the active browser says it can record, plus the “Best available” setting. Native browser recording uses `MediaRecorder.isTypeSupported()`; browser reports are a capability check, not an absolute guarantee that a large render will finish successfully.

## Export pipeline and limitations

1. The browser renders the edit timeline to a video stream in real time.
2. For a selected local output profile, the browser uploads that intermediate render to the loopback-only Python API.
3. FFmpeg transcodes it using the selected codec profile and returns the final file for download.

This architecture makes the file-export list much broader than browser-native recording alone, but it does not mean every obscure input codec can be previewed directly in every browser. Use the media-library conversion tool to make browser-compatible copies for uncommon source formats. Very large videos can use substantial disk space, memory and CPU; AV1/HEVC and lossless encodes may be slow. Animated images and some legacy or professional containers may not play in a browser even when FFmpeg successfully creates them.

The local server intentionally binds to `127.0.0.1`. Do not expose `server.py` to the public internet without authentication, request-size controls and deployment security. The default source/render upload limit is 2 GiB and the conversion/export time limit is 30 minutes.

## Project files

Editable projects use the `.motionlab` extension. A project can save edit settings and clip timing alone, or embed source media for portability. Embedded projects can be very large. Projects that do not embed sources require the source files to be relinked when opened on another device. Project metadata identifies the app as `kayralrics.com - video` and includes a `kayralrics.net` credit.

## Editing features

- Media library with drag-and-drop import, search, type filters and local browser preview.
- Multi-track timeline with video, image, audio and text layers.
- Clip movement, trimming, splitting, duplication and deletion, plus undo/redo for supported actions.
- Transform and image controls, filters, color adjustment, speed, opacity, rotation and audio-level controls.
- Text/title/caption overlays and preview snapshots.
- Export resolution, FPS and quality settings.
- Native browser render plus broad local FFmpeg output profiles.
- `.motionlab` project save, open, export and optional source embedding.
- `kayralrics.net` credits throughout the UI and project metadata.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Play / pause | `Space` |
| Split selected clip at playhead | `S` |
| Delete clip | `Delete` |
| Duplicate clip | `Ctrl/⌘ + D` |
| Undo / redo | `Ctrl/⌘ + Z` / `Ctrl/⌘ + Y` |
| Save project | `Ctrl/⌘ + S` |
| Open project | `Ctrl/⌘ + O` |

## Technologies

- HTML, CSS, deferred JavaScript
- Canvas 2D preview compositing
- HTML media elements and Web Audio API for playback/mixing
- `MediaRecorder` and `HTMLCanvasElement.captureStream()` for browser rendering
- Python's standard-library HTTP server
- Optional native FFmpeg format/encoder discovery, conversion and export
