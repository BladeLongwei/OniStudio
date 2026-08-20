/**
 * Per-segment toggle for multi-track Whisper transcripts (opt-in; default off).
 */
export const up = (db: { exec: (sql: string) => void }) => {
  db.exec(`
    ALTER TABLE episode_segments
    ADD COLUMN multi_track_whisper_enabled INTEGER NOT NULL DEFAULT 0;
  `);
};

export const down = (db: { exec: (sql: string) => void }) => {
  void db;
};
