"""Turn a recording into a playable Keystage song.

  1. Demucs (htdemucs_6s) splits the audio into drums, bass, other, vocals, guitar and piano.
  2. Basic Pitch transcribes the piano stem into notes: those are what you play.
  3. Everything except the piano is mixed back together as the band you play along with.
  4. librosa finds the beat so the highway's bar lines and star phrases line up.

This is an optional offline converter (Keystage itself is a static site). It writes a
.keystage song pack next to the recording; drop that pack onto the game to add the song.

  .venv/Scripts/python tools/audio_import.py <song.mp3|wav|flac|ogg> [--title T] [--artist A]
"""
import argparse
import json
import os
import tempfile
import time
import zipfile
from pathlib import Path

args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
args.add_argument("audio", type=Path)
args.add_argument("--title")
args.add_argument("--artist", default="")
args = args.parse_args()
SRC = args.audio
TITLE = args.title or SRC.stem.replace("_", " ")
OUT = Path(tempfile.mkdtemp(prefix="keystage-"))


def progress(stage, pct, msg):
    print(f"[{round(pct * 100):3d}%] {msg}", flush=True)


def separate(wav, sr):
    import torch
    import demucs.apply
    from demucs.pretrained import get_model

    torch.set_num_threads(os.cpu_count() or 4)
    progress("separate", 0.02, "Loading the separation model (first run downloads it)…")
    model = get_model("htdemucs_6s")
    model.eval()
    if sr != model.samplerate:
        raise ValueError(f"expected {model.samplerate} Hz audio, got {sr}")

    # Report Demucs's chunk progress (it uses tqdm internally).
    class Bar:
        def __init__(self, it, total=None, **_):
            self.it, self.total = it, total or len(it)

        def __iter__(self):
            shown = -1
            for i, x in enumerate(self.it):
                pct = 0.05 + 0.6 * i / self.total
                if int(pct * 20) != shown:  # every 5%
                    shown = int(pct * 20)
                    progress("separate", pct, "Separating the piano from the band…")
                yield x

    demucs.apply.tqdm.tqdm = Bar
    x = torch.from_numpy(wav.T.copy()).float()  # (channels, samples)
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        stems = demucs.apply.apply_model(model, ((x - mean) / std)[None], split=True, overlap=0.25, progress=True)[0]
    stems = stems * std + mean
    return {name: stems[i].numpy().T for i, name in enumerate(model.sources)}


def transcribe(piano_path):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    progress("transcribe", 0.7, "Listening to the piano and writing down the notes…")
    _, midi, events = predict(
        str(piano_path),
        ICASSP_2022_MODEL_PATH,
        onset_threshold=0.6,
        frame_threshold=0.35,
        minimum_note_length=80,
        minimum_frequency=27.5,
        maximum_frequency=4186,
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    midi.write(str(OUT / "notes.mid"))
    notes = []
    for start, end, pitch, amp, *_ in events:
        if 21 <= pitch <= 108 and amp >= 0.25 and end - start >= 0.06:
            notes.append({"t": round(float(start), 4), "d": round(float(end - start), 4), "p": int(pitch), "v": round(float(amp), 3)})
    notes.sort(key=lambda n: (n["t"], n["p"]))
    # Drop repeats of a pitch that is still sounding (transcription stutter).
    clean, last = [], {}
    for n in notes:
        prev = last.get(n["p"])
        if prev and n["t"] < prev["t"] + prev["d"] - 0.02 and n["t"] - prev["t"] < 0.12:
            prev["d"] = max(prev["d"], n["t"] + n["d"] - prev["t"])
            continue
        clean.append(n)
        last[n["p"]] = n
    return clean


def find_beat(stems, sr):
    import librosa
    import numpy as np

    progress("beat", 0.9, "Finding the beat…")
    rhythm = stems["drums"] + stems["bass"]
    if np.abs(stems["drums"]).mean() < 0.005:  # no drums: use the whole band
        rhythm = sum(v for k, v in stems.items() if k != "vocals")
    y = librosa.resample(rhythm.mean(axis=1), orig_sr=sr, target_sr=22050)
    env = librosa.onset.onset_strength(y=y, sr=22050)
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=22050)
    tempo = float(np.atleast_1d(tempo)[0])
    beats = librosa.frames_to_time(frames, sr=22050)
    if len(beats) < 8 or not 50 <= tempo <= 220:
        return 120.0, 0.0, beats.tolist()
    # Of the four ways to group beats into bars, the downbeat is usually the strongest.
    strength = env[frames]
    phase = max(range(4), key=lambda k: strength[k::4].mean() if len(strength[k::4]) else 0)
    return tempo, float(beats[phase]), [round(float(b), 4) for b in beats]


def main():
    import numpy as np
    import soundfile as sf

    started = time.time()
    wav, sr = sf.read(str(SRC), dtype="float32", always_2d=True)
    if wav.shape[1] == 1:
        wav = np.repeat(wav, 2, axis=1)
    if sr != 44100:  # the separation model works at 44.1 kHz
        import librosa

        wav, sr = librosa.resample(wav[:, :2].T, orig_sr=sr, target_sr=44100).T.copy(), 44100
    stems = separate(wav[:, :2], sr)

    progress("separate", 0.66, "Mixing the band without the piano…")
    piano = stems["piano"]
    band = sum(v for k, v in stems.items() if k != "piano")
    peak = max(np.abs(band).max(), np.abs(piano).max(), 1e-6)
    gain = min(1.0, 0.98 / peak)
    sf.write(str(OUT / "backing.ogg"), band * gain, sr, format="OGG", subtype="VORBIS")
    sf.write(str(OUT / "piano.ogg"), piano * gain, sr, format="OGG", subtype="VORBIS")
    sf.write(str(OUT / "piano.wav"), piano.mean(axis=1), sr)

    notes = transcribe(OUT / "piano.wav")
    (OUT / "piano.wav").unlink(missing_ok=True)
    if not notes:
        raise ValueError("No piano notes were found in this recording")
    bpm, downbeat, beats = find_beat(stems, sr)

    song = {
        "title": TITLE,
        "artist": args.artist,
        "source": "audio",
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "duration": round(len(wav) / sr, 3),
        "bpm": round(bpm, 2),
        "beatsPerBar": 4,
        "downbeat": round(downbeat, 4),
        "beats": beats,
        "notes": notes,
        "files": {"backing": "backing.ogg", "guide": "piano.ogg", "midi": "notes.mid"},
        "pianoLevel": round(float(np.sqrt((piano**2).mean() / max((band**2).mean(), 1e-12))), 3),
        "seconds": round(time.time() - started, 1),
    }
    (OUT / "song.json").write_text(json.dumps(song))
    pack = SRC.with_suffix(".keystage")
    with zipfile.ZipFile(pack, "w", zipfile.ZIP_STORED) as z:  # the audio is already compressed
        for name in ("song.json", "backing.ogg", "piano.ogg", "notes.mid"):
            z.write(OUT / name, name)
    progress("done", 1, f"Done in {song['seconds']:.0f}s: {len(notes)} notes at about {round(bpm)} BPM")
    print(f"Song pack: {pack}")


if __name__ == "__main__":
    main()
