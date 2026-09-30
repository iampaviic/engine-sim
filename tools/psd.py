#!/usr/bin/env python3
"""Average spectrum over a window, with engine-order markers.
usage: psd.py out.png file.wav:t0:t1:rpm:label [file2.wav:...]
"""
import sys, wave
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import signal


def load(path):
    with wave.open(path) as w:
        fs = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        x = x.reshape(-1, w.getnchannels()).mean(axis=1)
    return x, fs


out = sys.argv[1]
items = sys.argv[2:]
fig, axs = plt.subplots(len(items), 1, figsize=(14, 3.3 * len(items)))
if len(items) == 1:
    axs = [axs]
for ax, it in zip(axs, items):
    f, t0, t1, rpm, label = it.split(":")
    x, fs = load(f)
    seg = x[int(float(t0) * fs): int(float(t1) * fs)]
    fr, P = signal.welch(seg, fs, nperseg=16384, noverlap=12288)
    db = 10 * np.log10(P + 1e-16)
    ax.semilogx(fr, db, lw=0.7)
    base = float(rpm) / 60 / 2  # order 0.5 (per 720 deg cycle)
    top = db.max()
    for k in range(1, 80):
        fo = base * k
        if fo > 12000:
            break
        ax.axvline(fo, color="r" if k % 2 == 0 else "0.8", lw=0.3, alpha=0.6)
    ax.set_xlim(15, 16000)
    ax.set_ylim(top - 90, top + 5)
    # spectral centroid & band levels
    c = (fr * P).sum() / P.sum()
    bands = [(20, 200), (200, 1000), (1000, 4000), (4000, 16000)]
    bl = [10 * np.log10(P[(fr >= a) & (fr < b)].sum() + 1e-16) for a, b in bands]
    ax.set_title(f"{label}  rpm={rpm} centroid={c:.0f}Hz  bands " + " ".join(f"{b:.0f}" for b in bl))
    ax.grid(True, which="both", alpha=0.2)
fig.tight_layout()
fig.savefig(out, dpi=70)
print("->", out)
