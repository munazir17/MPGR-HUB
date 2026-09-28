"""Original MPGR Run score 'Neon Circuit' — CC0-1.0, no samples/dependencies.
Offline synthesis only. 128 BPM, 16 bars, 30 seconds, mono PCM16/44.1kHz.
Circular tail mixing preserves the musical seam; WAV adds no codec padding.
Run from repository root: python3 scripts/mpgr-run-compose-music.py
"""
import array
import math
import random
import sys
import wave
from pathlib import Path

RATE = 44100
BEAT = 60 / 128
COUNT = round(RATE * BEAT * 64)
track = array.array("f", [0.0]) * COUNT
rng = random.Random(630927)
TAU = 2 * math.pi


def add(start, length, voice):
    offset = round(start * RATE)
    for i in range(round(length * RATE)):
        track[(offset + i) % COUNT] += voice(i / RATE)


def note(midi, start, length, gain, kind):
    hz = 440 * 2 ** ((midi - 69) / 12)
    def voice(t):
        attack = min(1, t / (0.055 if kind == "pad" else 0.006))
        release = min(1, (length - t) / (0.16 if kind == "pad" else 0.045))
        phase = TAU * hz * t
        if kind == "pad":
            sound = math.sin(phase) + 0.16 * math.sin(phase * 2)
            envelope = 0.7
        elif kind == "bass":
            sound = math.sin(phase) + 0.3 * math.sin(phase * 2) + 0.12 * math.sin(phase * 3)
            envelope = math.exp(-t * 5)
        else:
            sound = math.sin(phase) + 0.25 * math.sin(phase * 2) + 0.1 * math.sin(phase * 4)
            envelope = math.exp(-t * 9)
        return gain * attack * release * envelope * sound
    add(start, length, voice)


roots = [48, 48, 44, 44, 51, 51, 46, 46] * 2
for bar, root in enumerate(roots):
    base = bar * 4 * BEAT
    third = 3 if root == 48 else 4
    chord = [0, third, 7, 12]
    for interval in [0, third, 7]:
        note(root + interval, base, 4 * BEAT + 0.18, 0.045, "pad")
    for step in range(8):
        note(root - 12 + (12 if step == 7 else 0), base + step * BEAT / 2,
             BEAT * 0.43, 0.19 if step % 2 == 0 else 0.14, "bass")
    for step in range(16):
        sequence = [0, 2, 1, 3] if bar < 8 else [3, 1, 2, 0]
        note(root + 12 + chord[sequence[step % 4]], base + step * BEAT / 4,
             BEAT * 0.42, 0.055 if step % 4 else 0.08, "arp")
        # Bright but restrained hats; random noise is generated only offline.
        add(base + step * BEAT / 4, 0.055,
            lambda t: rng.uniform(-1, 1) * 0.04 * min(1, t / 0.001) * math.exp(-t * 90))
    for beat in range(4):
        def kick(t):
            phase = TAU * (44 * t + 84 * 0.026 * (1 - math.exp(-t / 0.026)))
            return 0.46 * math.sin(phase) * min(1, t / 0.003) * math.exp(-t * 15)
        add(base + beat * BEAT, 0.35, kick)
        if beat % 2:
            add(base + beat * BEAT, 0.16,
                lambda t: (rng.uniform(-1, 1) * 0.12 + math.sin(TAU * 180 * t) * 0.055)
                * min(1, t / 0.002) * math.exp(-t * 28))

# Gentle peak normalization. Keep the waveform continuous at the wrap by
# bridging only 1ms at each edge, not adding silence or a duplicate sample.
edge = 44
middle = (track[-1] + track[0]) / 2
for i in range(edge):
    mix = i / edge
    track[i] = middle * (1 - mix) + track[i] * mix
    track[-1-i] = middle * (1 - mix) + track[-1-i] * mix
scale = 0.82 * 32767 / max(abs(x) for x in track)
pcm = array.array("h", (round(x * scale) for x in track))
if sys.byteorder != "little":
    pcm.byteswap()
output = Path("public/games/mpgr-run/audio/neon-circuit.wav")
output.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(output), "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(RATE)
    wav.writeframes(pcm.tobytes())
print(f"{output}: {COUNT / RATE:.2f}s, {output.stat().st_size} bytes, PCM16 mono, peak -1.72dBFS")
