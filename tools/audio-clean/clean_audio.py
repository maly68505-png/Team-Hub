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
    'social': dict(I=-14.0, TP=-1.0, LRA=7.0),    # YouTube / Instagram / podcasts
}

def chain(model):
    return ','.join([
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono',
        'highpass=f=80:poles=2',
        f"arnndn=m='{model}':mix=1",                     # AI noise removal
        'equalizer=f=250:t=q:w=1.0:g=-3',                # mud / boxiness
        'equalizer=f=1150:t=q:w=4:g=-2',                 # the narrow room ring around 1.1-1.2 kHz
        'equalizer=f=3000:t=q:w=0.9:g=5',                # presence: intelligibility
        'highshelf=f=6000:g=4',                          # air
        'aexciter=amount=1.5:drive=6:blend=0:freq=2500:ceil=12000',
        'deesser=i=0.4:m=0.5:f=0.5',
        'speechnorm=e=6:r=0.0005:l=1',                   # evens out loud and quiet sentences
        'acompressor=threshold=-22dB:ratio=3:attack=8:release=180:makeup=2',
        # levelling lifts the floor in the pauses too: clean it again and close the gaps gently
        'afftdn=nr=14:nf=-50:tn=1',
        'agate=threshold=0.012:ratio=2.5:range=0.12:attack=10:release=250:knee=4',
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
        return f"{pre},volume={g:.2f}dB,{limit},aformat=sample_rates=48000:channel_layouts=stereo"

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
    # pass 2: the limiter can shave a little off; correct once if we missed by more than 0.3 LU
    miss = tg['I'] - loudness(['-i', a.out], None)
    if abs(miss) > 0.3:
        r = render(gain + miss)
    if r.returncode:
        sys.exit(r.stderr)
    print(f"done -> {a.out}  (target {a.target}: {tg['I']} LUFS, TP {tg['TP']} dBTP)")

if __name__ == '__main__':
    main()
