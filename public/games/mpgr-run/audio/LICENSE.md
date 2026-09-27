# Neon Circuit — original MPGR Run music

The composition, synthesized recording `neon-circuit.wav`, and its offline score/generator `scripts/mpgr-run-compose-music.py` were created specifically for this project. No third-party samples, recordings, commercial songs, or external music services are used.

These music-specific materials are dedicated to the public domain under **CC0 1.0 Universal**:
https://creativecommons.org/publicdomain/zero/1.0/legalcode

To the extent possible under law, copyright and related rights in these materials are waived. They may be used, modified and redistributed, including commercially, without attribution. No warranty is provided. This dedication does not change the license of other project code or artwork.

Score: original 128 BPM electronic instrumental; sixteen bars (30 seconds), C minor / A-flat / E-flat / B-flat progression, synthesized bass, arpeggios, pads and percussion. Deterministic offline noise seed 630927. 44.1 kHz mono PCM16 WAV, circularly mixed tails and matched boundary samples, no encoder delay/padding. Native media `loop` handles repetition; gaplessness on specific mobile browsers still requires listening verification.

Regenerate from the repository root with Python 3 (standard library only):

    python3 scripts/mpgr-run-compose-music.py

Playback is a single HTMLAudioElement at 20% default volume. No real-time synthesis, DSP, audio library, third-party stream or per-frame audio work.
