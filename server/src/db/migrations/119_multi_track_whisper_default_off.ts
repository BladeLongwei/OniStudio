/**
 * Multi-track Whisper is opt-in until remaining issues are resolved.
 * Flip existing segments off; new rows use schema default false.
 */
export const up = (db: { exec: (sql: string) => void }) => {
  db.exec(`
    UPDATE episode_segments SET multi_track_whisper_enabled = 0;
  `);
};

export const down = (db: { exec: (sql: string) => void }) => {
  void db;
};
