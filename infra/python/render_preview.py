"""Render a reviewed local edit; this CLI does not generate or approve its script."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import wave
import zipfile


def validate_phrases(segment):
    phrases = segment.get("phrases", [])
    if not 1 <= len(phrases) <= 12:
        raise ValueError("Provide 1-12 spoken phrases")
    for phrase in phrases:
        text = phrase.get("text")
        pause = phrase.get("pauseMs", 200)
        if not isinstance(text, str) or not 1 <= len(text) <= 44:
            raise ValueError("Use short spoken phrases up to 44 characters")
        if type(pause) is not int or not 0 <= pause <= 800:
            raise ValueError("Phrase pauses must be 0-800ms")
    if "".join("".join(p["text"] for p in phrases).split()) != "".join(segment["text"].split()):
        raise ValueError("Spoken phrases must preserve the reviewed narration")


def phrase_timeline(phrases, measurements):
    if len(phrases) != len(measurements):
        raise ValueError("Each phrase requires measured audio")
    result, cursor = [], 0
    for phrase, (frames, rate) in zip(phrases, measurements):
        if frames <= 0 or rate <= 0:
            raise ValueError("Invalid phrase audio")
        speech_end = cursor + math.ceil(frames * 1000 / rate)
        end = speech_end + phrase.get("pauseMs", 200)
        result.append({"text": phrase["text"], "startMs": cursor,
                       "speechEndMs": speech_end, "endMs": end})
        cursor = end
    return result


def validate_manifest(manifest, pack, styled=False):
    if manifest.get("reviewed") is not True or manifest.get("rightsConfirmed") is not True:
        raise ValueError("A reviewed edit and confirmed source rights are required")
    if not isinstance(manifest.get("title"), str) or not 1 <= len(manifest["title"]) <= 80:
        raise ValueError("Title must contain 1-80 characters")
    segments = manifest.get("segments", [])
    if not 1 <= len(segments) <= 12:
        raise ValueError("Provide 1-12 narration segments")
    originals = {s["id"]: s for s in pack["transcriptSegments"]}
    for segment in segments:
        if styled and "phrases" not in segment:
            raise ValueError("Styled captions require explicitly measured short phrases")
        if "phrases" in segment:
            validate_phrases(segment)
        text = segment.get("text", "")
        captions = segment.get("captions", [])
        if not isinstance(text, str) or not 1 <= len(text) <= 300:
            raise ValueError("Narration must contain 1-300 characters")
        if not 1 <= len(captions) <= (12 if "phrases" in segment else 4) or any(not isinstance(c, str) or not 1 <= len(c) <= 44 for c in captions):
            raise ValueError("Provide 1-4 short caption lines")
        if "".join("".join(captions).split()) != "".join(text.split()):
            raise ValueError("Captions must match spoken text")
        start, end = segment.get("sourceStartMs"), segment.get("sourceEndMs")
        if (type(start) is not int or type(end) is not int or
                not 0 <= start < end <= pack["durationMs"]):
            raise ValueError("Edit range exceeds source duration")
        evidence = segment.get("evidence", [])
        if not evidence:
            raise ValueError("Narration requires transcript evidence")
        for item in evidence:
            source = originals.get(item.get("segmentId"))
            quote = item.get("quote", "")
            if not source or len(quote) < 2 or quote not in source["text"]:
                raise ValueError("Unknown or fabricated evidence")
        if not any(start < originals[e["segmentId"]]["endMs"] and end > originals[e["segmentId"]]["startMs"] for e in evidence):
            raise ValueError("Selected footage must overlap cited evidence")


def make_timeline(manifest, audio_samples):
    if len(audio_samples) != len(manifest["segments"]):
        raise ValueError("One measured voice file per segment is required")
    timeline, cursor = [], 0
    for segment, (frames, rate) in zip(manifest["segments"], audio_samples):
        if frames <= 0 or rate <= 0:
            raise ValueError("Invalid measured audio")
        duration = math.ceil(frames * 1000 / rate) + 250
        if duration > segment["sourceEndMs"] - segment["sourceStartMs"]:
            raise ValueError("Selected footage is shorter than narration; extend the reviewed range")
        timeline.append({"startMs": cursor, "endMs": cursor + duration,
                         "sourceStartMs": segment["sourceStartMs"], "durationMs": duration})
        cursor += duration
    return timeline


def ass_time(ms):
    ticks = round(ms / 10)
    return f"{ticks // 360000}:{ticks // 6000 % 60:02}:{ticks // 100 % 60:02}.{ticks % 100:02}"


def safe_ass(text):
    return text.replace("\\", "").replace("{", "").replace("}", "").replace("\n", " ").replace("\r", " ")


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 2
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Leelawadee UI,33,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,36,36,220,1
Style: Title,Leelawadee UI,42,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,8,36,36,178,1
Style: Label,Leelawadee UI,23,&H0046E4C8,&H0046E4C8,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1,0,8,36,36,110,1
Style: Credit,Leelawadee UI,19,&H00C8C8C8,&H00C8C8C8,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,36,36,92,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_text(manifest, timeline, credit="Voice: Meta MMS Thai / CC-BY-NC 4.0"):
    end = ass_time(timeline[-1]["endMs"])
    events = [f"Dialogue: 0,0:00:00.00,{end},Title,,0,0,0,,{safe_ass(manifest['title'])}",
              f"Dialogue: 0,0:00:00.00,{end},Label,,0,0,0,,RIFFCUT / EDITORIAL PREVIEW",
              f"Dialogue: 0,0:00:00.00,{end},Credit,,0,0,0,,{safe_ass(manifest.get('sourceCredit', 'Ani-Mi Thailand / Episode 1'))}\\N{safe_ass(credit)}"]
    for segment, timing in zip(manifest["segments"], timeline):
        lines = segment["captions"]
        # Two short lines per card; time cards from the measured utterance duration.
        cards = [lines[i:i + 2] for i in range(0, len(lines), 2)]
        total = sum(len(line) for line in lines)
        cursor = timing["startMs"]
        for index, card in enumerate(cards):
            end_ms = timing["endMs"] if index == len(cards) - 1 else cursor + round(timing["durationMs"] * sum(map(len, card)) / total)
            caption = "\\N".join(safe_ass(line) for line in card)
            events.append(f"Dialogue: 0,{ass_time(cursor)},{ass_time(end_ms)},Caption,,0,0,0,,{caption}")
            cursor = end_ms
    return ASS_HEADER + "\n".join(events) + "\n"


def styled_ass(manifest, timeline, phrases, credit):
    header = ASS_HEADER.split("[Events]")[0]
    header = header.replace("Leelawadee UI", "Kanit")
    header = header.replace("Caption,Kanit,33", "Caption,Kanit,54")
    header = header.replace("Title,Kanit,42", "Title,Kanit,58")
    header = header.replace("Label,Kanit,23", "Label,Kanit,24")
    header += "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    end = ass_time(timeline[-1]["endMs"])
    events = [f"Dialogue: 0,0:00:00.00,{end},Label,,0,0,0,,{{\\an8\\pos(360,108)}}RIFFCUT / ANIME RECAP",
              f"Dialogue: 0,0:00:00.00,{end},Title,,0,0,0,,{{\\an8\\pos(360,168)\\b1}}{safe_ass(manifest['title'])}",
              f"Dialogue: 0,0:00:00.00,{end},Credit,,0,0,0,,{{\\an2\\pos(360,1170)}}{safe_ass(manifest.get('sourceCredit', 'Ani-Mi Thailand / Episode 1'))}\\N{safe_ass(credit)}"]
    for segment, timing, cards in zip(manifest["segments"], timeline, phrases):
        for card in cards:
            text = safe_ass(card["text"])
            for keyword in segment.get("keywords", []):
                clean = safe_ass(keyword)
                if clean:
                    text = text.replace(clean, "{\\1c&H55DCFF&}" + clean + "{\\1c&HFFFFFF&}")
            motion = "{\\an5\\move(360,930,360,916,0,110)\\b1\\bord4\\shad1\\fad(55,70)\\fscx96\\fscy96\\t(0,110,\\fscx100\\fscy100)}"
            events.append(f"Dialogue: 1,{ass_time(timing['startMs'] + card['startMs'])},{ass_time(timing['startMs'] + card['endMs'])},Caption,,0,0,0,,{motion}{text}")
    return header + "\n".join(events) + "\n"


def sound_bed(seconds, cuts, rate=48000):
    """Original quiet suspense bed with soft pulses and transition swells."""
    import numpy as np
    t = np.arange(math.ceil(seconds * rate)) / rate
    rng = np.random.default_rng(42)
    bed = np.zeros_like(t)
    for frequency in [65.406, 97.999, 155.563]:
        bed += 0.012 * np.sin(2 * np.pi * frequency * t) * (0.75 + 0.25 * np.sin(2 * np.pi * 0.08 * t))
    for beat in np.arange(0, seconds, 60 / 84):
        dt = t - beat
        mask = (dt >= 0) & (dt < 0.24)
        bed[mask] += 0.045 * np.exp(-dt[mask] * 20) * np.sin(2 * np.pi * 82.407 * dt[mask])
    for index, cut in enumerate(cuts):
        dt = t - cut
        mask = (dt >= 0) & (dt < 0.65)
        x = dt[mask]
        # A low impact and a soft airy sweep mark scene changes without dialogue.
        bed[mask] += 0.055 * np.exp(-x * 12) * np.sin(2 * np.pi * (95 * x - 35 * x * x))
        bed[mask] += 0.009 * rng.standard_normal(len(x)) * np.sin(np.pi * x / 0.65) ** 2
        if index >= 3:
            bed[mask] += 0.018 * np.sin(2 * np.pi * 523.251 * x) * np.exp(-x * 9)
    fade = np.minimum(np.clip(t / 0.8, 0, 1), np.clip((seconds - t) / 1.2, 0, 1))
    bed *= fade * 2.2
    return np.stack([bed, bed * (0.94 + 0.06 * np.sin(2 * np.pi * 0.15 * t))], axis=1).clip(-0.22, 0.22).astype("float32")


def run(command, directory):
    subprocess.run(command, cwd=directory, check=True, timeout=300,
                   stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def edit_fingerprint(manifest, pack_id):
    return hashlib.sha256(json.dumps([manifest, pack_id], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def save_voice_checkpoint(directory, manifest, pack_id, data):
    payload = {**data, "editHash": edit_fingerprint(manifest, pack_id)}
    path = directory / "voices.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("voices.json", json.dumps(payload, ensure_ascii=False))
        for index in range(len(manifest["segments"])):
            archive.write(directory / f"voice-{index}.wav", f"voice-{index}.wav")
    return path


def load_voice_checkpoint(path, directory, manifest, pack_id):
    allowed = {"voices.json", *(f"voice-{i}.wav" for i in range(len(manifest["segments"])))}
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if (len(members) != len(allowed) or {m.filename for m in members} != allowed or
                sum(m.file_size for m in members) > 32 * 1024 * 1024 or archive.getinfo("voices.json").file_size > 1024 * 1024):
            raise ValueError("Invalid voice checkpoint archive")
        data = json.loads(archive.read("voices.json"))
        if data.get("editHash") != edit_fingerprint(manifest, pack_id):
            raise ValueError("Voice checkpoint belongs to another edit")
        if len(data["measurements"]) != len(manifest["segments"]) or len(data["phrases"]) != len(manifest["segments"]):
            raise ValueError("Incomplete voice checkpoint")
        for index, measurement in enumerate(data["measurements"]):
            target = directory / f"voice-{index}.wav"
            target.write_bytes(archive.read(target.name))
            with wave.open(str(target), "rb") as audio:
                if [audio.getnframes(), audio.getframerate()] != measurement or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                    raise ValueError("Voice checkpoint measurement mismatch")
    return data


def render(args):
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    pack = json.loads(args.pack.read_text(encoding="utf-8-sig"))
    validate_manifest(manifest, pack, styled=bool(args.fonts))
    source = args.source.resolve(strict=args.stage != 'voice')
    model_dir = args.model.resolve(strict=True)
    # A unique output directory preserves prior previews and failed-run diagnostics.
    directory = args.output.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    os.environ["HF_HUB_OFFLINE"] = "1"
    import numpy as np
    if args.stage == 'render':
        if not args.checkpoint:
            raise ValueError('Render stage requires a completed voice checkpoint')
        data = load_voice_checkpoint(args.checkpoint, directory, manifest, pack.get('id'))
        measurements, all_phrases = data['measurements'], data['phrases']
        voice_name, voice_license = data['model'], data['license']
    else:
        if args.voice_engine == "fastthai":
            from pythaitts.pretrained.fastthaig2p.tts import TTS
            model = TTS(model_dir / "kokoro_thai.onnx", model_dir / "thai_som.npy",
                        config_path=model_dir / "config.json", intra_op_threads=4)
            rate = 24000
            synthesize = model.generate
            voice_name, voice_license = "FastThaiG2P v0.3.0 / thai_som", "Apache-2.0 (upstream repository)"
        else:
            import torch
            from transformers import AutoTokenizer, VitsModel, set_seed
            torch.set_num_threads(4)
            set_seed(42)
            tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
            model = VitsModel.from_pretrained(model_dir, local_files_only=True).eval()
            rate = model.config.sampling_rate

            def synthesize(text):
                with torch.inference_mode():
                    return model(**tokenizer(text, return_tensors="pt")).waveform[0].cpu().numpy()
            voice_name, voice_license = "facebook/mms-tts-tha", "CC-BY-NC-4.0"
        measurements, all_phrases = [], []
        for index, segment in enumerate(manifest["segments"]):
            phrases = segment.get("phrases", [{"text": segment["text"], "pauseMs": 0}])
            chunks, phrase_measurements = [], []
            for phrase in phrases:
                samples = synthesize(phrase["text"])
                if not len(samples) or not np.isfinite(samples).all() or np.max(np.abs(samples)) < 0.001:
                    raise ValueError("Voice model produced empty or invalid audio")
                phrase_measurements.append((len(samples), rate))
                chunks.extend([samples, np.zeros(round(rate * phrase.get("pauseMs", 200) / 1000))])
            all_phrases.append(phrase_timeline(phrases, phrase_measurements))
            pcm = (np.clip(np.concatenate(chunks), -1, 1) * 32767).astype("<i2")
            with wave.open(str(directory / f"voice-{index}.wav"), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(rate)
                audio.writeframes(pcm.tobytes())
            measurements.append((len(pcm), rate))
            print(f"Voice {index + 1}: {len(pcm) / rate:.2f}s", flush=True)
    timeline = make_timeline(manifest, measurements)
    if not 30000 <= timeline[-1]["endMs"] <= 60000:
        raise ValueError("Preview must measure 30-60 seconds; revise the reviewed narration")
    if args.stage == 'voice':
        path = save_voice_checkpoint(directory, manifest, pack.get('id'), {
            'measurements': measurements, 'phrases': all_phrases,
            'model': voice_name, 'license': voice_license})
        print(path)
        return
    if args.fonts:
        shutil.copytree(args.fonts.resolve(strict=True), directory / "fonts")
    captions = styled_ass(manifest, timeline, all_phrases, voice_name) if args.fonts else ass_text(manifest, timeline, voice_name)
    (directory / "captions.ass").write_text(captions, encoding="utf-8")
    visual_filter = "[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x111824,setsar=1,fps=30[v];"
    if args.fonts:
        visual_filter = ("[0:v]split[bg][fg];[bg]scale=180:320:force_original_aspect_ratio=increase,crop=180:320,"
                         "gblur=sigma=12,scale=720:1280,eq=brightness=-0.32:saturation=0.45[back];"
                         "[fg]scale=720:-2[front];[back][front]overlay=0:(H-h)/2-40,setsar=1,fps=30[v];")
    for index, timing in enumerate(timeline):
        duration = timing["durationMs"] / 1000
        run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
             "-protocol_whitelist", "file", "-ss", str(timing["sourceStartMs"] / 1000), "-i", str(source),
             "-i", f"voice-{index}.wav", "-filter_complex_threads", "2", "-filter_complex",
             visual_filter + "[1:a]apad,loudnorm=I=-16:TP=-1.5:LRA=7[a]",
             "-map", "[v]", "-map", "[a]", "-t", str(duration), "-c:v", "libx264", "-preset", "fast",
             "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", f"part-{index}.mp4"], directory)
    (directory / "parts.txt").write_text("".join(f"file 'part-{i}.mp4'\n" for i in range(len(timeline))), encoding="utf-8")
    soundtrack_args = ["-map", "0:v", "-map", "0:a"]
    if args.soundtrack:
        bed = sound_bed(timeline[-1]["endMs"] / 1000 + 0.3, [t["startMs"] / 1000 for t in timeline])
        with wave.open(str(directory / "soundtrack.wav"), "wb") as audio:
            audio.setnchannels(2)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes((bed * 32767).astype("<i2").tobytes())
        soundtrack_args = ["-i", "soundtrack.wav", "-filter_complex",
                           "[0:a]asplit=2[vo][control];[1:a][control]sidechaincompress=threshold=0.06:ratio=6:attack=10:release=280[ducked];"
                           "[vo][ducked]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0[mix]",
                           "-map", "0:v", "-map", "[mix]"]
    run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "concat", "-safe", "1",
         "-i", "parts.txt", *soundtrack_args, "-vf", "ass=captions.ass" + (":fontsdir=fonts" if args.fonts else ""), "-c:v", "libx264", "-preset", "fast", "-crf", "20",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "preview.mp4"], directory)
    report = {"editorialPreview": True, "model": voice_name, "license": voice_license,
              "soundtrack": "original procedural suspense bed with speech ducking" if args.soundtrack else None,
              "measuredTimeline": timeline, "phraseTimings": all_phrases,
              "manifest": manifest, "knowledgePackId": pack.get("id")}
    (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(directory / "preview.mp4")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["manifest", "pack", "source", "model", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--stage", choices=["all", "voice", "render"], default="all")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--voice-engine", choices=["mms", "fastthai"], default="mms")
    parser.add_argument("--fonts", type=Path, help="Local directory containing Kanit Bold and its OFL license")
    parser.add_argument("--soundtrack", action="store_true")
    render(parser.parse_args())
