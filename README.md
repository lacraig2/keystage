# Keystage

A concert-stage rhythm game for piano: notes fall toward the keys and you play them on a MIDI keyboard, or on any piano through a microphone. It's a static site: plain HTML and JavaScript with no build step and no server code, so it can be hosted anywhere (GitHub Pages works). Everything a player adds (imported songs, recordings, play history) stays in their own browser.

## Play it locally

Browsers won't run it from a double-clicked file, so for testing serve the folder:

```
serve.bat            (or: python serve.py)
```

Then open http://localhost:8642 in Chrome or Edge (they support Web MIDI) and allow MIDI access.

## No MIDI cable? Use a microphone

**🎤 Use a microphone** on the title screen lets any piano play the game. Keystage listens through the mic and works out which keys you play. It works best when:

- the computer is close to the piano;
- you use headphones for the game's sound, or leave **Settings → filter out the game's own sound** on with speakers;
- you calibrate once with the microphone (with headphones on), since the mic keeps its own timing offset.

The game tells the listener which notes are due, so the song's notes are recognised reliably. Unexpected notes need stronger evidence, and sounds the game plays itself (the other hand, the bass) are ignored. A mic can only guess when a key is let go, so long held notes are judged a little more loosely.

## Publish on GitHub Pages

Push this folder to a GitHub repository, then **Settings → Pages → Deploy from a branch → main / (root)**. GitHub Pages serves over https, which Web MIDI needs.

## Getting songs in

- **Built-in songs** (`js/songs.js`): public domain or original only, since they ship with the game.
- **MIDI files**: drop a `.mid` onto the page. **🔎 Find songs** links to free sources (BitMidi, FreeMIDI, Online Sequencer, MIDIWorld, Mutopia, piano-midi.de).
- **Recordings**: drop an MP3, M4A or WAV. In the browser, Demucs (htdemucs_6s via onnxruntime-web) separates the piano, Basic Pitch writes down its notes, and the original mix minus the piano becomes the band. The models (about 300 MB) download from Hugging Face and jsDelivr on first use and are cached. It's fastest in a browser with WebGPU.
- **Song packs** (`.keystage`): a zip of `song.json`, `backing.ogg` and `piano.ogg`. `tools/audio_import.py` makes them offline with the Python versions of the same models (optional: `python -m venv .venv`, then `.venv/Scripts/pip install torch demucs basic-pitch soundfile`).

## Layout

| File | What it does |
|---|---|
| `js/songs.js` | Built-in songs (compact note strings), band styles, simplify |
| `js/midi.js` | Standard MIDI File parser; turns any MIDI into a song plus a backing band |
| `js/hands.js` | Splits a part between the hands and suggests fingering |
| `js/audioimport.js` | Recording → song: separation, transcription, beat tracking |
| `js/separate.worker.js` | Demucs piano separation in a Web Worker (WebGPU, or the CPU) |
| `js/library.js` | Recordings, song packs and play history in IndexedDB |
| `js/game.js` | Clock, judging (Perfect/Great/Good), combo, Spotlight (double points), crowd, Practice wait mode |
| `js/audio.js` | WebAudio synth (drums, bells, bass, pads, piano), recording playback, time-stretch |
| `js/render.js` | Canvas stage, perspective highway, keyboard, particles, HUD |
| `js/input.js` | Web MIDI, microphone and computer-keyboard input |
| `js/pitch.js` | Hears piano notes in microphone audio (onsets, then harmonic matching) |
| `js/mic.worklet.js` | Passes microphone audio from the audio thread to `pitch.js` |
| `serve.py` | Local test server, plus a `/fetch` proxy so URL imports work locally |
| `tests/logic.html` | Judging, practice, MIDI, hands, songs, packs, time-stretch |
| `tests/mic.html` | Microphone note detection on synthesized piano: scales, chords, bass, pedal, noise, wrong octave |
| `tests/micdevice.html` | The whole microphone path, using Chrome's fake microphone (flags in the file) |
| `tests/audio.html` | Transcription and beat tracking (`?separate` also runs piano separation) |

`?watch=<songId>` jumps straight to watch mode (for example `?watch=bells`).
