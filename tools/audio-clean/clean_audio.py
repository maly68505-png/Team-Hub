"""Clean and level a voice recording in one go (the audio "auto cut").

usage:
  python3 clean_audio.py in.(mp3|wav|mp4|mov) out.(wav|mp3|mp4) [--target tv|social] [--ss 30 --t 120]

Chain (ffmpeg, streamed, so a 50-minute file is fine):
  high-pass -> RNNoise (AI noise removal) -> FFT denoise of what is left -> EQ (mud cut,
  presence, air) -> harmonic exciter (rebuilds some of the highs a muffled recording lost)
  -> de-esser -> speech leveller -> compressor -> two-pass EBU R128 loudness -> true-peak limit.
Output is stereo (voice centred on both channels). With a video input/output the picture
is copied untouched and only the audio is replaced.
"""
import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = {
    'tv':     dict(I=-23.0, TP=-1.0, LRA=7.0),    # EBU R128 broadcast
    'social': dict(I=-16.0, TP=-1.0, LRA=7.0),    # podcasts / spoken social video (-14 squashes a quiet source)
}

def chain(model):
    # the exciter rebuilds lost highs by adding harmonics: kept mild, it turns harsh when pushed
    return ','.join([
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono',
        'highpass=f=90:poles=2',
        'afftdn=nr=8:nf=-60:tn=1',                       # light broadband clean first
        f"arnndn=m='{model}':mix=0.8",                   # AI denoise, not fully wet (fewer watery artefacts)
        'equalizer=f=180:t=q:w=1.2:g=-2',
        'equalizer=f=320:t=q:w=1.0:g=-4',                # mud / boxiness
        'equalizer=f=1150:t=q:w=4:g=-2',                 # room ring around 1.1-1.2 kHz
        'equalizer=f=2200:t=q:w=1.2:g=4',                # where this voice still has energy
        'equalizer=f=3600:t=q:w=1.0:g=6',                # presence
        'highshelf=f=7000:g=2',
        'aexciter=amount=1:drive=3.5:blend=0:freq=3000:ceil=11000',
        'deesser=i=0.3:m=0.5:f=0.5',
        'speechnorm=e=4:r=0.0005:l=1',
        'acompressor=threshold=-24dB:ratio=2.5:attack=12:release=200:knee=4:makeup=1',
        'afftdn=nr=10:nf=-55:tn=1',
        'agate=threshold=0.01:ratio=2:range=0.18:attack=15:release=300:knee=6',
    ])

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--target', choices=TARGETS, default='tv')
    ap.add_argument('--ss', type=float, help='start (s), for a test excerpt')
    ap.add_argument('--t', type=float, help='duration (s)')
    ap.add_argument('--model', default=os.path.join(HERE, 'models', 'sh.rnnn'))
    a = ap.parse_args()

    trim = (['-ss', str(a.ss)] if a.ss is not None else []) + (['-t', str(a.t)] if a.t is not None else [])
    pre = chain(a.model)
    tg = TARGETS[a.target]

    def loudness(src_args, af):
        r = run(['ffmpeg', '-hide_banner', '-nostats', *src_args, '-vn', '-af', f'{af},ebur128=peak=true' if af else 'ebur128=peak=true',
                 '-f', 'null', '-'])
        return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r.stderr)[-1])

    # pass 1: loudness of the processed voice, then a plain gain to the target + true-peak limiter
    gain = tg['I'] - loudness([*trim, '-i', a.inp], pre)
    limit = f"alimiter=limit={10 ** ((tg['TP'] - 0.3) / 20):.4f}:attack=5:release=50:level=false"

    def post(g):
        # a soft peak compressor takes the edge off before the limiter, so it never has to clip hard
        return (f"{pre},volume={g:.2f}dB,acompressor=threshold=-10dB:ratio=3:attack=3:release=80:knee=6,"
                f"{limit},aformat=sample_rates=48000:channel_layouts=stereo")

    def render(g):
        if a.out.lower().endswith(('.mp4', '.mov', '.mxf')):     # picture copied, audio replaced
            cmd = ['ffmpeg', '-v', 'error', '-y', *trim, '-i', a.inp, '-map', '0:v:0', '-map', '0:a:0',
                   '-c:v', 'copy', '-af', post(g), '-c:a', 'aac', '-b:a', '320k', a.out]
        else:
            codec = ['-c:a', 'libmp3lame', '-b:a', '320k'] if a.out.lower().endswith('.mp3') else ['-c:a', 'pcm_s24le']
            cmd = ['ffmpeg', '-v', 'error', '-y', *trim, '-i', a.inp, '-vn', '-af', post(g), *codec, a.out]
        return run(cmd)

    r = render(gain)
    if r.returncode:
        sys.exit(r.stderr)
    # the peak compressor and limiter shave a little off: re-measure and correct until within 0.3 LU
    for _ in range(3):
        miss = tg['I'] - loudness(['-i', a.out], None)
        if abs(miss) <= 0.3:
            break
        gain += miss
        r = render(gain)
        if r.returncode:
            sys.exit(r.stderr)
    print(f"done -> {a.out}  (target {a.target}: {tg['I']} LUFS, TP {tg['TP']} dBTP)")

if __name__ == '__main__':
    main()
