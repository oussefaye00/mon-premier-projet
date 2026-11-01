"""Synthesized SFX for the 15 s showreel, placed on the exact animation times of film.html.
Writes out/sfx_raw.wav, then two-pass loudnorm to -14 LUFS / TP -1 -> out/audio.wav."""
import json, subprocess, wave
from pathlib import Path
import numpy as np

H = Path(__file__).parent
SR, T = 48000, 15.0
mix = np.zeros((int(SR * T), 2), np.float32)
rng = np.random.default_rng(7)  # deterministic noise


def env(n, a=0.004, r=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / a) if a > 0 else np.ones(n)
    return e * (np.exp(-t / r) if r else 1)


def add(t0, sig, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    sig = sig[: max(0, len(mix) - i)] * gain
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    mix[i:i + len(sig), 0] += sig * l * 1.41
    mix[i:i + len(sig), 1] += sig * r * 1.41


def sweep(f0, f1, dur, curve=2.0):
    n = int(dur * SR); k = (np.arange(n) / n) ** curve
    f = f0 + (f1 - f0) * k
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def thump(dur=0.35, f0=140, f1=42):
    return sweep(f0, f1, dur, 0.5) * env(int(dur * SR), 0.002, dur / 4)


def pop(f0=420, f1=980, dur=0.07):
    return sweep(f0, f1, dur, 0.7) * env(int(dur * SR), 0.002, dur / 3)


def tick(f=2400, dur=0.03):
    n = int(dur * SR)
    return (np.sin(2 * np.pi * f * np.arange(n) / SR) * 0.6 + rng.standard_normal(n) * 0.4) * env(n, 0.0005, 0.006)


def whoosh(dur=0.35, lo=300, hi=3000, rise=False):
    n = int(dur * SR)
    x = rng.standard_normal(n)
    spec = np.fft.rfft(x); fr = np.fft.rfftfreq(n, 1 / SR)
    spec *= ((fr > lo) & (fr < hi)) * (1 / np.sqrt(np.maximum(fr, 50) / 300))
    x = np.fft.irfft(spec, n); x /= np.abs(x).max() + 1e-9
    w = np.linspace(0, 1, n)
    shape = w ** 2.2 if rise else np.sin(np.pi * w) ** 1.6
    return x * shape


def chime(dur=1.6):
    n = int(dur * SR); t = np.arange(n) / SR
    s = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / d) for f, a, d in [(880, .5, .5), (1320, .3, .35), (1760, .15, .25), (2640, .06, .15)])
    return s * env(n, 0.003)


# --- 1. hook (timings follow film.html v2)
add(0.35, thump(), 0.55)
add(0.62, whoosh(0.3, 400, 2500), 0.10)
for i in range(6): add(0.9 + i * 0.055 + 0.08, tick(2000 + i * 120), 0.10, -0.4 + i * 0.16)
# --- 2. wipe
add(2.40, pop(300, 700, 0.09), 0.25)
add(2.68, whoosh(0.4, 250, 2200), 0.22)
add(3.07, whoosh(0.4, 600, 5000), 0.24, 0.3)
add(3.42, pop(500, 1100), 0.25, 0.5)
add(4.22, whoosh(0.25, 400, 3000), 0.12)
# --- 3. flood
add(4.40, whoosh(0.62, 150, 4000, rise=True), 0.35)
add(5.02, thump(0.6, 110, 34), 0.75)
add(5.02, whoosh(0.25, 2000, 9000), 0.10)
add(5.17, tick(1800), 0.18); add(5.40, tick(2200), 0.15)
add(6.45, whoosh(0.25, 400, 3000), 0.14)
add(6.85, whoosh(0.45, 200, 2000), 0.18)
# --- 4. rhythm
for ring in range(2): add(7.32 + ring * 0.06, pop(380 + ring * 120, 900 + ring * 200), 0.22)
add(8.00, tick(2100), 0.12)
for k in range(5):
    add(8.40 + k * 0.07, tick(1500 + k * 260, 0.035), 0.20, -0.6 + k * 0.3)
    add(8.94 + (4 - k) * 0.07, tick(2600 - k * 220, 0.035), 0.18, 0.6 - k * 0.3)
add(9.45, whoosh(0.25, 400, 3000), 0.10)
add(9.62, whoosh(0.45, 300, 3000), 0.20)
# --- 5. timing
add(10.27, tick(2300), 0.14)
run = sweep(220, 660, 1.1, 1.0) * np.sin(np.pi * np.linspace(0, 1, int(1.1 * SR))) ** 2
add(10.45, run, 0.07)
add(11.70, whoosh(0.25, 400, 3000), 0.10)
# --- 6. signature
add(11.62, whoosh(0.55, 300, 4000), 0.20, 0.2)
for i in range(9): add(11.95 + i * 0.04 + 0.06, tick(2400, 0.02), 0.06, -0.5 + i * 0.12)
add(12.22, thump(0.5, 160, 60), 0.40)
add(13.0, chime(), 0.30)

# tail fade
fade = int(0.6 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
mix /= max(1.0, np.abs(mix).max() / 0.9)
(H / "out").mkdir(exist_ok=True)
raw = H / "out/sfx_raw.wav"
with wave.open(str(raw), "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())

m = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(raw), "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"],
                   capture_output=True, text=True).stderr
j = json.loads(m[m.rindex("{"):m.rindex("}") + 1])
af = (f"loudnorm=I=-14:TP=-1:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}"
      f":measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", af, "-ar", str(SR), str(H / "out/audio.wav")], check=True)
print("audio ok", j["input_i"], "->", "-14 LUFS")
