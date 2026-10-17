#!/usr/bin/env python3
"""kayralrics.com - video local server with dynamic FFmpeg conversion and export."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import webbrowser
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
MAX_UPLOAD = int(os.environ.get("MAX_CONVERT_BYTES", str(2 * 1024**3)))
FFMPEG = shutil.which("ffmpeg")

# These are practical export profiles, not a claim that every format ever invented
# is encodable. The available list is filtered against the user's actual FFmpeg
# muxers and encoders, so unsupported combinations are never offered in the UI.
FORMAT_PROFILES = [
    # Video containers / codecs
    {"id":"mp4", "label":"MP4 · H.264 / AAC", "extension":"mp4", "kind":"video", "muxer":"mp4", "vcodec":"libx264", "acodec":"aac", "mime":"video/mp4", "preset":"h264", "faststart":True, "description":"Best general-purpose compatibility"},
    {"id":"mp4-hevc", "label":"MP4 · H.265 / HEVC", "extension":"mp4", "kind":"video", "muxer":"mp4", "vcodec":"libx265", "acodec":"aac", "mime":"video/mp4", "preset":"hevc", "faststart":True, "description":"Smaller files; newer-device compatibility"},
    {"id":"mp4-av1", "label":"MP4 · AV1", "extension":"mp4", "kind":"video", "muxer":"mp4", "vcodec":"libaom-av1", "acodec":"aac", "mime":"video/mp4", "preset":"av1", "faststart":True, "description":"Modern codec; encoding may be slow"},
    {"id":"m4v", "label":"M4V · H.264 / AAC", "extension":"m4v", "kind":"video", "muxer":"mp4", "vcodec":"libx264", "acodec":"aac", "mime":"video/mp4", "preset":"h264", "faststart":True},
    {"id":"mov", "label":"QuickTime MOV · H.264 / AAC", "extension":"mov", "kind":"video", "muxer":"mov", "vcodec":"libx264", "acodec":"aac", "mime":"video/quicktime", "preset":"h264", "faststart":True},
    {"id":"mov-prores", "label":"QuickTime MOV · ProRes 422", "extension":"mov", "kind":"video", "muxer":"mov", "vcodec":"prores_ks", "acodec":"pcm_s16le", "mime":"video/quicktime", "preset":"prores", "faststart":False},
    {"id":"mkv", "label":"Matroska MKV · H.264 / AAC", "extension":"mkv", "kind":"video", "muxer":"matroska", "vcodec":"libx264", "acodec":"aac", "mime":"video/x-matroska", "preset":"h264"},
    {"id":"mkv-hevc", "label":"Matroska MKV · H.265 / HEVC", "extension":"mkv", "kind":"video", "muxer":"matroska", "vcodec":"libx265", "acodec":"aac", "mime":"video/x-matroska", "preset":"hevc"},
    {"id":"mkv-av1", "label":"Matroska MKV · AV1 / Opus", "extension":"mkv", "kind":"video", "muxer":"matroska", "vcodec":"libaom-av1", "acodec":"libopus", "mime":"video/x-matroska", "preset":"av1"},
    {"id":"mkv-lossless", "label":"Matroska MKV · FFV1 Lossless", "extension":"mkv", "kind":"video", "muxer":"matroska", "vcodec":"ffv1", "acodec":"pcm_s16le", "mime":"video/x-matroska", "preset":"lossless"},
    {"id":"webm", "label":"WebM · VP9 / Opus", "extension":"webm", "kind":"video", "muxer":"webm", "vcodec":"libvpx-vp9", "acodec":"libopus", "mime":"video/webm", "preset":"vp9"},
    {"id":"webm-vp8", "label":"WebM · VP8 / Vorbis", "extension":"webm", "kind":"video", "muxer":"webm", "vcodec":"libvpx", "acodec":"libvorbis", "mime":"video/webm", "preset":"vp8"},
    {"id":"avi", "label":"AVI · MPEG-4 / PCM", "extension":"avi", "kind":"video", "muxer":"avi", "vcodec":"mpeg4", "acodec":"pcm_s16le", "mime":"video/x-msvideo", "preset":"mpeg4"},
    {"id":"avi-xvid", "label":"AVI · Xvid / MP3", "extension":"avi", "kind":"video", "muxer":"avi", "vcodec":"libxvid", "acodec":"libmp3lame", "mime":"video/x-msvideo", "preset":"xvid"},
    {"id":"flv", "label":"Flash Video FLV · FLV1 / MP3", "extension":"flv", "kind":"video", "muxer":"flv", "vcodec":"flv", "acodec":"libmp3lame", "mime":"video/x-flv", "preset":"flv"},
    {"id":"mpeg", "label":"MPEG Program Stream · MPEG-2 / MP2", "extension":"mpg", "kind":"video", "muxer":"mpeg", "vcodec":"mpeg2video", "acodec":"mp2", "mime":"video/mpeg", "preset":"mpeg2"},
    {"id":"mpegts", "label":"MPEG Transport Stream · MPEG-2 / MP2", "extension":"ts", "kind":"video", "muxer":"mpegts", "vcodec":"mpeg2video", "acodec":"mp2", "mime":"video/mp2t", "preset":"mpeg2"},
    {"id":"vob", "label":"DVD VOB · MPEG-2 / AC-3", "extension":"vob", "kind":"video", "muxer":"vob", "vcodec":"mpeg2video", "acodec":"ac3", "mime":"video/mpeg", "preset":"mpeg2"},
    {"id":"3gp", "label":"3GP · H.264 / AAC", "extension":"3gp", "kind":"video", "muxer":"3gp", "vcodec":"libx264", "acodec":"aac", "mime":"video/3gpp", "preset":"h264"},
    {"id":"3g2", "label":"3G2 · H.264 / AAC", "extension":"3g2", "kind":"video", "muxer":"3g2", "vcodec":"libx264", "acodec":"aac", "mime":"video/3gpp2", "preset":"h264"},
    {"id":"ogv", "label":"Ogg Video OGV · Theora / Vorbis", "extension":"ogv", "kind":"video", "muxer":"ogg", "vcodec":"libtheora", "acodec":"libvorbis", "mime":"video/ogg", "preset":"theora"},
    {"id":"mxf", "label":"MXF · MPEG-2 / PCM (25 FPS)", "extension":"mxf", "kind":"video", "muxer":"mxf", "vcodec":"mpeg2video", "acodec":"pcm_s16le", "mime":"application/mxf", "preset":"mxf"},
    {"id":"asf", "label":"ASF / WMV · WMV2 / WMA", "extension":"asf", "kind":"video", "muxer":"asf", "vcodec":"wmv2", "acodec":"wmav2", "mime":"video/x-ms-asf", "preset":"wmv"},
    {"id":"dv", "label":"DV Video · PAL DV25 / PCM", "extension":"dv", "kind":"video", "muxer":"dv", "vcodec":"dvvideo", "acodec":"pcm_s16le", "mime":"video/x-dv", "preset":"dv"},
    {"id":"nut", "label":"NUT · FFV1 Lossless / PCM", "extension":"nut", "kind":"video", "muxer":"nut", "vcodec":"ffv1", "acodec":"pcm_s16le", "mime":"application/x-nut", "preset":"lossless"},
    {"id":"gif", "label":"Animated GIF · No audio", "extension":"gif", "kind":"animation", "muxer":"gif", "vcodec":"gif", "acodec":None, "mime":"image/gif", "preset":"gif"},
    {"id":"apng", "label":"Animated PNG · No audio", "extension":"apng", "kind":"animation", "muxer":"apng", "vcodec":"apng", "acodec":None, "mime":"image/apng", "preset":"apng"},
    {"id":"webp-anim", "label":"Animated WebP · No audio", "extension":"webp", "kind":"animation", "muxer":"webp", "vcodec":"libwebp_anim", "acodec":None, "mime":"image/webp", "preset":"webp"},
    # Audio-only deliveries extracted from the rendered timeline audio.
    {"id":"mp3", "label":"MP3 Audio", "extension":"mp3", "kind":"audio", "muxer":"mp3", "vcodec":None, "acodec":"libmp3lame", "mime":"audio/mpeg", "preset":"mp3"},
    {"id":"m4a", "label":"M4A Audio · AAC", "extension":"m4a", "kind":"audio", "muxer":"ipod", "vcodec":None, "acodec":"aac", "mime":"audio/mp4", "preset":"aac"},
    {"id":"aac", "label":"AAC Audio", "extension":"aac", "kind":"audio", "muxer":"adts", "vcodec":None, "acodec":"aac", "mime":"audio/aac", "preset":"aac"},
    {"id":"wav", "label":"WAV Audio · 16-bit PCM", "extension":"wav", "kind":"audio", "muxer":"wav", "vcodec":None, "acodec":"pcm_s16le", "mime":"audio/wav", "preset":"pcm"},
    {"id":"wav-24", "label":"WAV Audio · 24-bit PCM", "extension":"wav", "kind":"audio", "muxer":"wav", "vcodec":None, "acodec":"pcm_s24le", "mime":"audio/wav", "preset":"pcm24"},
    {"id":"flac", "label":"FLAC Lossless Audio", "extension":"flac", "kind":"audio", "muxer":"flac", "vcodec":None, "acodec":"flac", "mime":"audio/flac", "preset":"flac"},
    {"id":"ogg-audio", "label":"Ogg Vorbis Audio", "extension":"ogg", "kind":"audio", "muxer":"ogg", "vcodec":None, "acodec":"libvorbis", "mime":"audio/ogg", "preset":"vorbis"},
    {"id":"opus", "label":"Opus Audio", "extension":"opus", "kind":"audio", "muxer":"opus", "vcodec":None, "acodec":"libopus", "mime":"audio/ogg", "preset":"opus"},
    {"id":"aiff", "label":"AIFF Audio · PCM", "extension":"aiff", "kind":"audio", "muxer":"aiff", "vcodec":None, "acodec":"pcm_s16be", "mime":"audio/aiff", "preset":"pcm"},
    {"id":"ac3-audio", "label":"Dolby AC-3 Audio", "extension":"ac3", "kind":"audio", "muxer":"ac3", "vcodec":None, "acodec":"ac3", "mime":"audio/ac3", "preset":"ac3"},
    {"id":"eac3-audio", "label":"Dolby Digital Plus E-AC-3 Audio", "extension":"eac3", "kind":"audio", "muxer":"eac3", "vcodec":None, "acodec":"eac3", "mime":"audio/eac3", "preset":"ac3"},
    {"id":"wma", "label":"WMA Audio", "extension":"wma", "kind":"audio", "muxer":"asf", "vcodec":None, "acodec":"wmav2", "mime":"audio/x-ms-wma", "preset":"wma"},
    {"id":"alac", "label":"ALAC Lossless Audio · M4A", "extension":"m4a", "kind":"audio", "muxer":"ipod", "vcodec":None, "acodec":"alac", "mime":"audio/mp4", "preset":"alac"},
]


@lru_cache(maxsize=1)
def ffmpeg_capabilities():
    """Return output muxers and encoders actually compiled into the local FFmpeg."""
    if not FFMPEG:
        return {"muxers": set(), "encoders": set()}
    muxers, encoders = set(), set()
    try:
        result = subprocess.run([FFMPEG, "-hide_banner", "-muxers"], capture_output=True, text=True, timeout=10)
        for line in (result.stdout + "\n" + result.stderr).splitlines():
            # FFmpeg prints three status columns followed by a name; leading
            # spaces are part of those columns, so don't consume them first.
            status = line[:3] if len(line) >= 3 else ""
            remainder = line[3:].strip() if len(line) > 3 else ""
            if "E" in status and remainder:
                muxer_name = remainder.split()[0]
                if re.fullmatch(r"[A-Za-z0-9_]+", muxer_name):
                    muxers.add(muxer_name)
        result = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=10)
        for line in (result.stdout + "\n" + result.stderr).splitlines():
            match = re.match(r"^\s*([A-Z.]{6})\s+(\S+)\s{2,}", line)
            if match:
                encoders.add(match.group(2))
    except (OSError, subprocess.TimeoutExpired):
        return {"muxers": set(), "encoders": set()}
    return {"muxers": muxers, "encoders": encoders}


def supported_profiles():
    caps = ffmpeg_capabilities()
    output = []
    for profile in FORMAT_PROFILES:
        if profile["muxer"] not in caps["muxers"]:
            continue
        if profile.get("vcodec") and profile["vcodec"] not in caps["encoders"]:
            continue
        if profile.get("acodec") and profile["acodec"] not in caps["encoders"]:
            continue
        output.append({key: profile[key] for key in ("id", "label", "extension", "kind", "mime", "description") if key in profile})
    return output


class KayralricsVideoHandler(SimpleHTTPRequestHandler):
    server_version = "KayralricsVideo/2.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # Local-first editor: keep the terminal useful without logging request bodies.
        super().log_message(fmt, *args)

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/status":
            version = None
            if FFMPEG:
                try:
                    result = subprocess.run(
                        [FFMPEG, "-version"], capture_output=True, text=True,
                        timeout=4, check=False,
                    )
                    version = (result.stdout.splitlines() or [""])[0][:180] or None
                except Exception:
                    version = None
            profiles = supported_profiles() if FFMPEG else []
            self._send_json(200, {
                "available": bool(FFMPEG),
                "engine": "FFmpeg" if FFMPEG else None,
                "version": version,
                "conversionEndpoint": "/api/convert",
                "exportEndpoint": "/api/export",
                "exportFormats": [p["id"] for p in profiles],
                "exportFormatCount": len(profiles),
                "maxUploadBytes": MAX_UPLOAD,
            })
            return
        if path == "/api/formats":
            self._send_json(200, {
                "available": bool(FFMPEG),
                "engine": "FFmpeg" if FFMPEG else None,
                "formats": supported_profiles() if FFMPEG else [],
            })
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/export":
            self._handle_export(parsed.query)
            return
        if parsed.path != "/api/convert":
            self._send_json(404, {"error": "Unknown API endpoint."})
            return
        if not FFMPEG:
            self._send_json(503, {
                "error": "FFmpeg is not installed on this device. Install FFmpeg and restart kayralrics.com - video to enable codec conversion."
            })
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Invalid Content-Length header."})
            return
        if content_length <= 0:
            self._send_json(400, {"error": "No media data was received."})
            return
        if content_length > MAX_UPLOAD:
            self._send_json(413, {"error": f"File exceeds the local conversion limit of {MAX_UPLOAD // (1024**3)} GiB."})
            return

        query = parse_qs(parsed.query)
        kind = query.get("kind", [""])[0].lower()
        if kind not in ("video", "audio", "image"):
            self._send_json(400, {"error": "Unsupported media type. Expected video, audio or image."})
            return

        raw_name = unquote(self.headers.get("X-File-Name", "input-media"))
        original = Path(raw_name.replace("\\", "/")).name
        # Only the suffix is reused in a temporary path. Never trust a user path.
        suffix = Path(original).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix or ""):
            suffix = ".bin"
        safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(original).stem).strip("._-") or "media"
        out_ext = ".m4a" if kind == "audio" else ".png" if kind == "image" else ".mp4"
        out_name = f"{safe_stem}.browser-ready{out_ext}"

        with tempfile.TemporaryDirectory(prefix="kayralrics-video-convert-") as temp_dir:
            temp = Path(temp_dir)
            source = temp / f"source{suffix}"
            target = temp / f"converted{out_ext}"
            remaining = content_length
            try:
                with source.open("wb") as destination:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Upload ended before all file data was received.")
                        destination.write(chunk)
                        remaining -= len(chunk)
            except (OSError, ValueError) as exc:
                self._send_json(400, {"error": str(exc)})
                return

            common = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
            if kind == "audio":
                command = common + ["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-f", "ipod", str(target)]
                content_type = "audio/mp4"
            elif kind == "image":
                command = common + ["-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-f", "image2", str(target)]
                content_type = "image/png"
            else:
                command = common + [
                    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", "-f", "mp4", str(target),
                ]
                content_type = "video/mp4"

            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=1800, check=False)
            except subprocess.TimeoutExpired:
                self._send_json(504, {"error": "Conversion exceeded the 30-minute limit."})
                return
            except OSError as exc:
                self._send_json(500, {"error": f"Could not start FFmpeg: {exc}"})
                return

            if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
                detail = (result.stderr or "FFmpeg could not convert this file.").strip()
                self._send_json(422, {"error": detail[-1600:]})
                return

            output_size = target.stat().st_size
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(output_size))
                self.send_header("X-Converted-Name", quote(out_name, safe=""))
                self.send_header("X-Converted-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with target.open("rb") as source_file:
                    shutil.copyfileobj(source_file, self.wfile, length=1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                # The user may cancel or close the tab during conversion/download.
                return


    def _handle_export(self, raw_query: str):
        if not FFMPEG:
            self._send_json(503, {"error": "Local FFmpeg export is unavailable. Install FFmpeg and restart kayralrics.com - video."})
            return
        query = parse_qs(raw_query)
        output_format = query.get("format", [""])[0].lower()
        profile = next((p for p in FORMAT_PROFILES if p["id"] == output_format), None)
        available_ids = {p["id"] for p in supported_profiles()}
        if not profile or output_format not in available_ids:
            self._send_json(400, {"error": "That output profile is unavailable in the installed FFmpeg build. Refresh the export menu or choose another profile."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Invalid Content-Length header."})
            return
        if content_length <= 0:
            self._send_json(400, {"error": "No rendered video data was received."})
            return
        if content_length > MAX_UPLOAD:
            self._send_json(413, {"error": f"Rendered file exceeds the local processing limit of {MAX_UPLOAD // (1024**3)} GiB."})
            return

        source_name = unquote(self.headers.get("X-File-Name", "rendered-video.webm"))
        source_ext = Path(source_name.replace("\\", "/")).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,10}", source_ext or ""):
            source_ext = ".webm"
        requested_name = unquote(self.headers.get("X-Export-Name", "kayralrics-video"))
        safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(requested_name).stem).strip("._-") or "kayralrics-video"
        out_ext = "." + profile["extension"]
        output_name = f"{safe_stem}{out_ext}"
        content_type = profile.get("mime", "application/octet-stream")

        with tempfile.TemporaryDirectory(prefix="kayralrics-video-export-") as temp_dir:
            temp = Path(temp_dir)
            source = temp / f"rendered{source_ext}"
            target = temp / f"exported{out_ext}"
            remaining = content_length
            try:
                with source.open("wb") as destination:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Upload ended before all rendered video data was received.")
                        destination.write(chunk)
                        remaining -= len(chunk)
            except (OSError, ValueError) as exc:
                self._send_json(400, {"error": str(exc)})
                return

            command = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
            kind = profile["kind"]
            preset = profile.get("preset", "h264")
            vcodec = profile.get("vcodec")
            acodec = profile.get("acodec")

            if kind == "audio":
                command += ["-map", "0:a:0", "-vn"]
            else:
                command += ["-map", "0:v:0"]
                if kind == "video":
                    command += ["-map", "0:a:0?", "-sn", "-dn"]
                else:
                    command += ["-an"]

            if vcodec:
                command += ["-c:v", vcodec]
            if preset == "h264":
                command += ["-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p"]
            elif preset == "hevc":
                command += ["-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p"]
            elif preset == "av1":
                command += ["-cpu-used", "8", "-crf", "32", "-b:v", "0", "-pix_fmt", "yuv420p"]
            elif preset == "prores":
                command += ["-profile:v", "3", "-pix_fmt", "yuv422p10le"]
            elif preset == "vp9":
                command += ["-deadline", "realtime", "-cpu-used", "4", "-crf", "32", "-b:v", "0"]
            elif preset == "vp8":
                command += ["-deadline", "realtime", "-cpu-used", "4", "-b:v", "2M"]
            elif preset in ("mpeg4", "xvid"):
                command += ["-q:v", "3"]
            elif preset == "flv":
                command += ["-q:v", "5"]
            elif preset == "mpeg2":
                command += ["-q:v", "3", "-pix_fmt", "yuv420p"]
            elif preset == "mxf":
                # This profile intentionally normalizes to the widely-used 25 fps MXF profile.
                command += ["-q:v", "3", "-pix_fmt", "yuv420p", "-r", "25"]
                command += ["-ar", "48000", "-ac", "2"]
            elif preset == "theora":
                command += ["-q:v", "7"]
            elif preset == "wmv":
                command += ["-b:v", "4M"]
            elif preset == "dv":
                # PAL DV profile: 720x576, 25 fps, 4:2:0, stereo 48 kHz PCM.
                command += ["-vf", "scale=720:576:force_original_aspect_ratio=decrease,pad=720:576:(ow-iw)/2:(oh-ih)/2,setsar=16/15,format=yuv420p", "-r", "25", "-ar", "48000", "-ac", "2"]
            elif preset == "lossless":
                command += ["-level", "3"] if vcodec == "ffv1" else []
            elif preset == "gif":
                command += ["-vf", "fps=12,scale=720:-1:flags=lanczos", "-loop", "0"]
            elif preset == "apng":
                command += ["-plays", "0"]
            elif preset == "webp":
                command += ["-loop", "0", "-quality", "80", "-compression_level", "4"]

            if acodec:
                command += ["-c:a", acodec]
                if preset in ("h264", "hevc", "av1"):
                    command += ["-b:a", "192k"]
                elif preset in ("vp9", "vp8", "theora"):
                    command += ["-b:a", "128k"]
                elif preset in ("mpeg2", "flv", "wmv", "xvid"):
                    command += ["-b:a", "192k"]
                elif preset == "mp3":
                    command += ["-q:a", "2"]
                elif preset == "aac":
                    command += ["-b:a", "192k"]
                elif preset == "opus":
                    command += ["-b:a", "160k"]
                elif preset == "vorbis":
                    command += ["-q:a", "5"]
                elif preset == "ac3":
                    command += ["-b:a", "192k"]
                elif preset == "wma":
                    command += ["-b:a", "192k"]
            if profile.get("faststart"):
                command += ["-movflags", "+faststart"]
            command += ["-f", profile["muxer"], str(target)]

            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=1800, check=False)
            except subprocess.TimeoutExpired:
                self._send_json(504, {"error": "Export conversion exceeded the 30-minute limit."})
                return
            except OSError as exc:
                self._send_json(500, {"error": f"Could not start FFmpeg: {exc}"})
                return
            if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
                detail = (result.stderr or "FFmpeg could not create this output format.").strip()
                if kind == "audio" and "Stream map '0:a:0' matches no streams" in detail:
                    detail = "This project render has no audio stream to export. Add or enable audio, then try again."
                self._send_json(422, {"error": detail[-2000:]})
                return

            output_size = target.stat().st_size
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(output_size))
                self.send_header("X-Export-Name", quote(output_name, safe=""))
                self.send_header("X-Export-Format", profile["id"])
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with target.open("rb") as exported:
                    shutil.copyfileobj(exported, self.wfile, length=1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                return



def main():
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: kayralrics.com - video may receive source media over the network. Bind to loopback unless you have secured this service.")

    # A common launch failure is another local development server already using
    # port 8080. Try a short consecutive range and announce the actual URL.
    httpd = None
    selected_port = PORT
    last_error = None
    for candidate in range(PORT, min(PORT + 31, 65536)):
        try:
            httpd = ThreadingHTTPServer((HOST, candidate), KayralricsVideoHandler)
            selected_port = candidate
            break
        except OSError as exc:
            last_error = exc
            if getattr(exc, "errno", None) not in (48, 98, 10048):  # address already in use
                raise
    if httpd is None:
        raise OSError(f"Could not find a free port between {PORT} and {min(PORT + 30, 65535)}") from last_error

    url = f"http://127.0.0.1:{selected_port}"
    print(f"kayralrics.com - video: {url}", flush=True)
    if selected_port != PORT:
        print(f"Port {PORT} was already in use; kayralrics.com - video selected port {selected_port}.", flush=True)
    print("Local media conversion: " + (f"enabled ({FFMPEG})" if FFMPEG else "unavailable (FFmpeg not found; browser-supported formats still work)"), flush=True)
    print("Keep this terminal open while editing. Press Ctrl+C to stop.", flush=True)
    if os.environ.get("MOTIONLAB_NO_OPEN") != "1":
        def open_browser():
            try:
                webbrowser.open_new_tab(url)
            except Exception:
                pass
        threading.Timer(0.8, open_browser).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down kayralrics.com - video…")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
