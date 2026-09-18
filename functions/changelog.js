// Source data for postWeeklyAppUpdate (see index.js). Add one entry per
// shipped feature worth telling the band about — keep `text` short and
// written for a band member, not a commit log. Entries are posted in
// order, oldest first, the first time the weekly job runs after they're
// added; anything already posted (tracked in meta/weeklyChangelog) is
// skipped even if this file is edited afterward.
module.exports = [
  {
    id: '2026-09-10-stage-meter-and-metronome',
    text: "App update: added a Stage Meter (checks stage volume + shows a live frequency readout) and made the Metronome full-screen with a volume fader and saved tempos. Shows list is also easier to tap through now."
  },
];
