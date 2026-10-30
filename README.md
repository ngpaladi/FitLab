# FitLab

Edit FIT activity files in the browser. Combine two recordings of the same
ride into one workout — GPS and heart rate from the head unit, power from the
phone app that was paired to the meter — matched second by second on the base
file's clock. Then crop, pause the café stop you forgot to pause, cut out the
lift home, or splice a ride split in two by a flat battery.

**[Open the tool →](https://www.noahpaladino.com/FitLab/)**

No server, no account. Files stay in the tab unless you upload the result to
intervals.icu.

A sibling of [CritLab](https://github.com/ngpaladi/CritLab),
[CrossLab](https://github.com/ngpaladi/CrossLab) and
[RouteLab](https://github.com/ngpaladi/RouteLab). They share settings and the
intervals.icu key: connect in any of them and FitLab has it.

## Features

- **Merge by timestamp**: the base file is the reference; pick which channels
  come from the second file and whether they only fill the base's gaps or
  replace its values. Power, heart rate, cadence, speed, altitude, GPS,
  temperature, pedalling dynamics, and developer fields (Stryd, CORE, Moxy…)
  with their definitions.
- **Clock offset, found for you**: cross-correlates a channel the files share,
  or, when they share none, when you stopped and started. Nudge by a second
  and watch the second file's traces slide over the base.
- **No invented data**: same-second samples are copied, short smart-recording
  gaps interpolated, longer dropouts left empty.
- **Crop, pause, cut, delete** a stretch selected on the chart or typed in.
  Pause writes timer stop/start events like auto-pause would; cut closes the
  gap and (optionally) takes out the distance.
- **Splice** the second file onto the end: one session, both files' laps,
  distance carrying on; the gap a pause, or closed up.
- **Shift the clock**, **remove channels** (GPS for privacy), **clear spikes**,
  **set the sport**.
- **Undo everything**: a history of every step; click any one to go back.
- **intervals.icu**: list recent activities and open any as either file (the
  original upload when it's a FIT, intervals.icu's FIT rendering otherwise);
  upload the result as a new activity.

## What's kept

FitLab reads and writes FIT losslessly: every message and field, including
device info, HRV, developer fields and manufacturer-private messages. An
untouched file goes out unchanged. After an edit, laps and the session are
rebuilt from the samples (times, distance, averages and maxima, NP, work,
climbing when altitude changed); totals it can't recompute — TSS, IF, time in
zones, training effect — are removed rather than left wrong.

## Development

```bash
bundle install
bundle exec jekyll serve --livereload    # http://localhost:4000/FitLab/

npm install                              # jsdom and Garmin's FIT SDK, for the tests
npm test                                 # unit + DOM, offline
```

Jekyll and plain JavaScript, no build step and no runtime dependencies; GitHub
Pages builds it on push. The tests write fixtures with Garmin's
[FIT JavaScript SDK](https://github.com/garmin/fit-javascript-sdk) and check
every file FitLab writes with Garmin's decoder.

The shared intervals.icu key only works on the shared origin
(`www.noahpaladino.com`): a copy served from anywhere else has its own
storage, and asks for the key again.

## Licence

MIT.
