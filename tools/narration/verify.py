#!/usr/bin/env python3
"""
Objective review of the recorded narration (tools/narration/generate.py output):

  * intelligibility / pronunciation - every file is transcribed by an independent speech
    recogniser (NVIDIA Parakeet-TDT 0.6B v2 via sherpa-onnx) and compared word by word
    with the spoken script; mismatched words point at mispronunciations;
  * loudness (EBU R128 integrated LUFS) and peak level of every file;
  * pace (words per minute) and the longest silence inside each instruction.

Writes docs/narration-review.md. A human listening pass is still recommended; this
catches mispronounced terms, clipped or silent files and inconsistent levels.

    python3 tools/narration/verify.py --asr ~/.cache/mf550-narration/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
    (model: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)
"""
import argparse, difflib, json, re, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / 'public' / 'assets' / 'narration'
REPORT = ROOT / 'docs' / 'narration-review.md'

UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
         'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']


def words_of_number(n):
    n = int(n)
    if n < 20: return UNITS[n]
    if n < 100: return TENS[n // 10] + ('' if n % 10 == 0 else ' ' + UNITS[n % 10])
    h, r = divmod(n, 100)
    return UNITS[h] + ' hundred' + ('' if r == 0 else ' ' + words_of_number(r))


def norm(text):
    t = text.lower().replace('mist-fit five fifty', 'mist fit five fifty')
    t = re.sub(r'\d+', lambda m: words_of_number(m.group()), t)
    t = re.sub(r"[^a-z' ]+", ' ', t.replace('-', ' '))
    return t.split()


def decode(path, sr=16000):
    import numpy as np
    pcm = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asr', required=True, help='sherpa-onnx Parakeet-TDT model folder')
    args = ap.parse_args()
    import numpy as np, pyloudnorm, sherpa_onnx
    d = Path(args.asr)
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / 'encoder.int8.onnx'), decoder=str(d / 'decoder.int8.onnx'), joiner=str(d / 'joiner.int8.onnx'),
        tokens=str(d / 'tokens.txt'), model_type='nemo_transducer', num_threads=2)
    manifest = json.loads((OUT_DIR / 'manifest.json').read_text())
    script = {p['key']: p for p in json.loads(subprocess.run(
        ['node', '--no-warnings', str(ROOT / 'tools/narration/export-script.mjs')], capture_output=True, text=True, check=True).stdout)['positions']}

    rows, issues, total_words, total_err = [], [], 0, 0
    for key, e in manifest['entries'].items():
        a16 = decode(OUT_DIR / e['file'])
        s = rec.create_stream(); s.accept_waveform(16000, a16); rec.decode_stream(s)
        heard = s.result.text.strip()
        ref, hyp = norm(script[key]['speech']), norm(heard)
        sm = difflib.SequenceMatcher(None, ref, hyp, autojunk=False)
        diffs = [(' '.join(ref[i1:i2]), ' '.join(hyp[j1:j2])) for t, i1, i2, j1, j2 in sm.get_opcodes() if t != 'equal']
        errors = sum(max(i2 - i1, j2 - j1) for t, i1, i2, j1, j2 in sm.get_opcodes() if t != 'equal')
        total_words += len(ref); total_err += errors
        a24 = decode(OUT_DIR / e['file'], 24000)
        lufs = pyloudnorm.Meter(24000).integrated_loudness(a24)
        peak = 20 * np.log10(np.max(np.abs(a24)) + 1e-9)
        frame = 240                                           # 10 ms frames: longest silence
        rms = np.sqrt(np.mean(a24[: len(a24) // frame * frame].reshape(-1, frame) ** 2, axis=1))
        voiced = np.where(rms > 10 ** (-45 / 20))[0]
        inner = rms[voiced[0]: voiced[-1] + 1] if len(voiced) else rms
        longest, run = 0, 0
        for v in inner:
            run = run + 1 if v <= 10 ** (-45 / 20) else 0
            longest = max(longest, run)
        speech_s = (voiced[-1] - voiced[0] + 1) * frame / 24000 if len(voiced) else 0
        wpm = len(ref) / speech_s * 60 if speech_s else 0
        rows.append((key, e['duration'], len(ref), wpm, lufs, peak, longest * frame / 24000, errors, diffs, heard))
        if diffs:
            issues.append((key, diffs, heard))
        print(f"{key:10} {e['duration']:5.2f}s wpm {wpm:5.0f} {lufs:6.1f} LUFS pk {peak:5.1f} err {errors}  {diffs if diffs else ''}", flush=True)

    lufs_all = [r[4] for r in rows]; wpm_all = [r[3] for r in rows]
    md = ['# Narration review (generated)', '',
          f"Voice: {manifest['voice']['model']} - {manifest['voice']['voiceName']} ({manifest['voice']['lang']}), speed {manifest['voice']['speed']}. "
          f"Checked by `tools/narration/verify.py` with an independent speech recogniser (NVIDIA Parakeet-TDT 0.6B v2).", '',
          f"* **Recordings:** {len(rows)} ({manifest['totalSeconds'] / 60:.1f} min, {manifest['totalBytes'] / 1e6:.2f} MB)",
          f"* **Word accuracy of the transcription:** {100 * (1 - total_err / total_words):.1f} % ({total_err} differing words of {total_words})",
          f"* **Loudness:** {min(lufs_all):.1f} to {max(lufs_all):.1f} LUFS (target {manifest['format']['loudnessLUFS']}); highest peak {max(r[5] for r in rows):.1f} dBFS",
          f"* **Pace:** {min(wpm_all):.0f}-{max(wpm_all):.0f} words/min (median {sorted(wpm_all)[len(wpm_all) // 2]:.0f})", '',
          '## Differences between script and transcription', '']
    if not issues:
        md.append('None: every recording was transcribed exactly as scripted.')
    for key, diffs, heard in issues:
        md.append(f"* **{key}** - " + '; '.join(f'script "{a}" → heard "{b}"' for a, b in diffs) + f'  \n  transcript: "{heard}"')
    md += ['', '## All recordings', '', '| Key | Duration | Words | Words/min | Loudness (LUFS) | Peak (dBFS) | Longest pause | Differences |',
           '|---|---:|---:|---:|---:|---:|---:|---:|']
    for key, dur, n, wpm, lufs, peak, pause, err, _, _ in rows:
        md.append(f'| {key} | {dur:.2f} s | {n} | {wpm:.0f} | {lufs:.1f} | {peak:.1f} | {pause:.2f} s | {err} |')
    REPORT.write_text('\n'.join(md) + '\n')
    print(f'\nword accuracy {100 * (1 - total_err / total_words):.1f} %, {len(issues)} files with differences -> {REPORT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
