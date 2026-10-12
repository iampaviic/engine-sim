#!/usr/bin/env python3
"""Spectrogram / waveform / order analysis for rendered WAVs.

usage: analyze.py file.wav [out.png] [--csv file.csv] [--t0 s --t1 s]
"""
import sys, wave, argparse
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import signal


def load(path):
    with wave.open(path) as w:
        n = w.getnframes()
        fs = w.getframerate()
        ch = w.getnchannels()
        x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    x = x.reshape(-1, ch)
    return x, fs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--csv")
    ap.add_argument("--t0", type=float, default=0)
    ap.add_argument("--t1", type=float, default=None)
    ap.add_argument("--fmax", type=float, default=8000)
    ap.add_argument("--zoom", type=float, default=None, help="time (s) for waveform zoom")
    a = ap.parse_args()
    x, fs = load(a.wav)
    t1 = a.t1 or len(x) / fs
    seg = x[int(a.t0 * fs): int(t1 * fs)]
    mono = seg.mean(axis=1)
    out = a.out or a.wav.replace(".wav", ".png")
    rows = 4 if a.csv else 3
    fig, ax = plt.subplots(rows, 1, figsize=(14, 3.2 * rows))
    f, t, S = signal.spectrogram(mono, fs, nperseg=4096, noverlap=3584, window="hann")
    Sdb = 10 * np.log10(S + 1e-14)
    vmax = Sdb.max()
    ax[0].pcolormesh(t + a.t0, f, Sdb, vmin=vmax - 80, vmax=vmax, shading="auto", cmap="magma")
    ax[0].set_ylim(20, a.fmax)
    ax[0].set_yscale("log")
    ax[0].set_ylabel("Hz")
    ax[0].set_title(a.wav.split("/")[-1])
    # waveform
    tt = np.arange(len(mono)) / fs + a.t0
    ax[1].plot(tt, seg[:, 0], lw=0.3)
    ax[1].set_xlim(a.t0, t1)
    ax[1].set_ylabel("L")
    # zoom
    z = a.zoom if a.zoom is not None else (a.t0 + t1) / 2
    i0 = int((z - a.t0) * fs)
    w = int(0.08 * fs)
    ax[2].plot(np.arange(w) / fs * 1000, seg[i0: i0 + w, 0], lw=0.8)
    ax[2].set_xlabel(f"ms (from t={z:.2f}s)")
    if a.csv:
        import csv
        rows_ = list(csv.DictReader(open(a.csv)))
        tc = np.array([float(r["t"]) for r in rows_])
        rpm = np.array([float(r["rpm"]) for r in rows_])
        ax[3].plot(tc, rpm, label="rpm")
        ax2 = ax[3].twinx()
        ax2.plot(tc, [float(r["tq"]) for r in rows_], color="C1", lw=0.6, label="torque")
        ax[3].set_xlim(a.t0, t1)
        ax[3].set_ylabel("rpm")
    fig.tight_layout()
    fig.savefig(out, dpi=70)
    # summary stats
    rms = np.sqrt(np.mean(mono ** 2))
    print(f"rms {rms:.4f} peak {np.abs(seg).max():.3f} -> {out}")


if __name__ == "__main__":
    main()
