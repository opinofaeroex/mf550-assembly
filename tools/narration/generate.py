#!/usr/bin/env python3
"""
Record the natural-voice narration of every navigation position (overview, parts kit,
69 steps, completion) as small MP3 files + a manifest, for static hosting (GitHub Pages).

Voice engine: Kokoro-82M v1.0 (open-weight neural TTS, Apache-2.0), run locally with
onnxruntime - no account, no API key, no network service at runtime.
Phonemes: misaki (Kokoro's own G2P) + tools/narration/lexicon.json overrides.

    pip install -r tools/narration/requirements.txt
    npm run narration                    # = python3 tools/narration/generate.py
    python3 tools/narration/generate.py --only step-08 step-42 --force

Only positions whose spoken text, pronunciation or voice settings changed are re-recorded
(content hash in the manifest), and recordings that are no longer referenced are removed.
"""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / 'public' / 'assets' / 'narration'
MANIFEST = OUT_DIR / 'manifest.json'
LEXICON = Path(__file__).with_name('lexicon.json')

MODEL_FILES = {   # https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
    'kokoro-v1.0.onnx': '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}
MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'

SETTINGS = {
    'model': 'Kokoro-82M v1.0',
    'voice': 'af_heart',            # "Heart": warm, clear US-English female voice (highest-graded Kokoro voice)
    'voiceName': 'Heart',
    'lang': 'en-US',
    'speed': 0.92,                  # moderate pace: easy to follow while watching the animation
    'pauseAfterStepNumber': 0.30,   # "Step 3." <pause> "Fit six ..."
    'pauseBetweenSentences': 0.45,
    'leadIn': 0.08, 'tail': 0.25,
    'loudnessLUFS': -17.0,          # same perceived volume for every recording (EBU R128 integrated)
    'peakDBFS': -1.5,               # sample-peak ceiling enforced by a look-ahead limiter
    'bitrate': '48k', 'sampleRate': 24000,
}
SENTENCE_RE = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"\'(])')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def ensure_models(d: Path):
    d.mkdir(parents=True, exist_ok=True)
    for name, digest in MODEL_FILES.items():
        p = d / name
        if not p.exists():
            print(f'downloading {name} ...', flush=True)
            urllib.request.urlretrieve(MODEL_URL + name, p)
        if sha256(p) != digest:
            sys.exit(f'{p}: checksum mismatch - delete it and run again')
    return d / 'kokoro-v1.0.onnx', d / 'voices-v1.0.bin'


def load_g2p():
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
    from misaki import en, espeak
    return en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False))


def limit(audio, sr):
    """Look-ahead peak limiter (ffmpeg alimiter, 5 ms attack, delay compensated)."""
    lin = 10 ** (SETTINGS['peakDBFS'] / 20)
    r = subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', '-',
                        '-af', f'alimiter=limit={lin:.4f}:attack=5:release=60:level=0:latency=1', '-f', 'f32le', '-'],
                       input=audio.astype('float32').tobytes(), capture_output=True, check=True)
    import numpy as np
    out = np.frombuffer(r.stdout, dtype=np.float32)
    return np.clip(out, -lin, lin)


def normalize(audio, sr, meter):
    """Bring every recording to the same integrated loudness without exceeding the peak ceiling."""
    import numpy as np
    lin = 10 ** (SETTINGS['peakDBFS'] / 20)
    for _ in range(4):
        audio = audio * 10 ** ((SETTINGS['loudnessLUFS'] - meter.integrated_loudness(audio)) / 20)
        if np.max(np.abs(audio)) > lin:
            audio = limit(audio, sr)
        if abs(meter.integrated_loudness(audio) - SETTINGS['loudnessLUFS']) < 0.3:
            break
    return audio.astype(np.float32)


def apply_lexicon(text, words):
    """Mark lexicon words with misaki's inline phoneme syntax: [word](/IPA/)."""
    for w, ipa in words.items():
        text = re.sub(rf'\b({re.escape(w)})\b', lambda m: f'[{m.group(1)}](/{ipa}/)', text, flags=re.I)
    return text


def export_script():
    r = subprocess.run(['node', '--no-warnings', str(ROOT / 'tools/narration/export-script.mjs')],
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--models', default=os.environ.get('KOKORO_DIR', str(Path.home() / '.cache' / 'mf550-narration')))
    ap.add_argument('--only', nargs='*', help='keys to (re)record, e.g. step-08 overview')
    ap.add_argument('--force', action='store_true', help='re-record even if unchanged')
    args = ap.parse_args()

    import numpy as np, pyloudnorm, soundfile  # noqa: F401  (soundfile: kokoro dependency)
    from kokoro_onnx import Kokoro

    script = export_script()
    lexicon = json.loads(LEXICON.read_text())['words']
    old = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {'entries': {}}
    voice_dir = OUT_DIR / f"{SETTINGS['lang']}-{SETTINGS['voiceName'].lower()}"
    voice_dir.mkdir(parents=True, exist_ok=True)

    model_path, voices_path = ensure_models(Path(args.models))
    model_sha = MODEL_FILES['kokoro-v1.0.onnx'][:16]
    kokoro = Kokoro(str(model_path), str(voices_path))
    g2p = load_g2p()
    sr = SETTINGS['sampleRate']
    meter = pyloudnorm.Meter(sr)

    entries, made, kept = {}, 0, 0
    t0 = time.time()
    for p in script['positions']:
        key = p['key']
        sentences = [s for s in SENTENCE_RE.split(p['speech']) if s.strip()]
        phonemes = [g2p(apply_lexicon(s, lexicon))[0] for s in sentences]
        digest = hashlib.sha256(json.dumps([phonemes, SETTINGS, model_sha], sort_keys=True).encode()).hexdigest()[:20]
        rel = f"{voice_dir.name}/{p['file']}.mp3"
        prev = old['entries'].get(key)
        wanted = args.only is None or key in args.only
        if prev and prev.get('hash') == digest and (OUT_DIR / prev['file']).exists() and not (args.force and wanted):
            entries[key] = {**prev, 'pos': p['pos'], 'text': p['text']}
            if prev['file'] != rel:            # renamed step title: keep audio, rename file
                (OUT_DIR / prev['file']).rename(OUT_DIR / rel)
                entries[key]['file'] = rel
            kept += 1
            continue
        if not wanted and prev and (OUT_DIR / prev['file']).exists():
            entries[key] = prev
            kept += 1
            continue

        parts = [np.zeros(int(sr * SETTINGS['leadIn']), np.float32)]
        for i, ph in enumerate(phonemes):
            audio, _ = kokoro.create(ph, voice=SETTINGS['voice'], speed=SETTINGS['speed'], is_phonemes=True, trim=True)
            parts.append(audio.astype(np.float32))
            if i < len(phonemes) - 1:
                gap = SETTINGS['pauseAfterStepNumber'] if re.fullmatch(r'Step \d+\.', sentences[i].strip()) else SETTINGS['pauseBetweenSentences']
                parts.append(np.zeros(int(sr * gap), np.float32))
        parts.append(np.zeros(int(sr * SETTINGS['tail']), np.float32))
        audio = np.concatenate(parts)

        audio = normalize(audio, sr, meter)

        out = OUT_DIR / rel
        title = 'Mist-Fit 550 - ' + ('Step ' + key[5:].lstrip('0') if key.startswith('step-') else key.replace('-', ' ').title())
        with tempfile.NamedTemporaryFile(suffix='.f32') as raw:
            raw.write(audio.tobytes()); raw.flush()
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', raw.name,
                            '-c:a', 'libmp3lame', '-b:a', SETTINGS['bitrate'], '-ar', str(sr),
                            '-metadata', f'title={title}', '-metadata', 'artist=AEROEX Technologies',
                            '-metadata', f"comment=Narration voice: {SETTINGS['model']} ({SETTINGS['voiceName']})", str(out)], check=True)
        if prev and prev['file'] != rel and (OUT_DIR / prev['file']).exists():
            (OUT_DIR / prev['file']).unlink()
        entries[key] = {'pos': p['pos'], 'file': rel, 'text': p['text'], 'duration': round(len(audio) / sr, 2),
                        'bytes': out.stat().st_size, 'hash': digest}
        made += 1
        print(f"  {key:10} {entries[key]['duration']:5.2f}s  {p['speech'][:70]}", flush=True)

    referenced = {e['file'] for e in entries.values()}
    for f in OUT_DIR.glob('*/*.mp3'):
        if f'{f.parent.name}/{f.name}' not in referenced:
            f.unlink()
            print(f'  removed unreferenced {f.parent.name}/{f.name}')

    manifest = {
        'version': 1,
        'product': script['product'],
        'voice': {k: SETTINGS[k] for k in ('model', 'voice', 'voiceName', 'lang', 'speed')} | {
            'license': 'Apache-2.0 (Kokoro-82M weights)', 'engine': 'kokoro-onnx + misaki G2P'},
        'format': {'codec': 'mp3', 'mime': 'audio/mpeg', 'sampleRate': sr, 'bitrate': SETTINGS['bitrate'],
                   'channels': 1, 'loudnessLUFS': SETTINGS['loudnessLUFS']},
        'count': len(entries),
        'totalBytes': sum(e['bytes'] for e in entries.values()),
        'totalSeconds': round(sum(e['duration'] for e in entries.values()), 1),
        'entries': entries,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + '\n')
    print(f'{made} recorded, {kept} unchanged, {len(entries)} total, '
          f"{manifest['totalBytes'] / 1e6:.2f} MB, {manifest['totalSeconds'] / 60:.1f} min of audio ({time.time() - t0:.0f} s)")


if __name__ == '__main__':
    main()
