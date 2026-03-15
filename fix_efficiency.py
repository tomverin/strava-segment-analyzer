#!/usr/bin/env python3
"""
One-time migration: fix efforts that inherited activity-level power/HR.

For each effort, compares average_watts and average_heartrate against the
parent activity.  When they match exactly (meaning they were copied by the
old fallback logic rather than coming from the segment effort itself), the
fields are NULLed out so the next sync re-populates them from Strava.

Efficiency is then recalculated for every row from its own columns.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path("data/strava.db")


def main():
    if not DB_PATH.exists():
        print(f"Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # 1. Find efforts whose power/HR was copied from the activity
    contaminated = conn.execute(
        """
        SELECT e.id,
               e.average_watts      AS e_watts,
               a.average_watts      AS a_watts,
               e.average_heartrate  AS e_hr,
               a.average_heartrate  AS a_hr
          FROM efforts e
          JOIN activities a ON a.id = e.activity_id
         WHERE (e.average_watts IS NOT NULL
                AND a.average_watts IS NOT NULL
                AND e.average_watts = a.average_watts)
            OR (e.average_heartrate IS NOT NULL
                AND a.average_heartrate IS NOT NULL
                AND e.average_heartrate = a.average_heartrate
                AND e.average_watts IS NOT NULL
                AND a.average_watts IS NOT NULL
                AND e.average_watts = a.average_watts)
        """
    ).fetchall()

    print(f"Found {len(contaminated)} efforts with activity-level fallback values")

    if contaminated:
        # NULL out fields that were copied from the activity
        conn.execute(
            """
            UPDATE efforts
               SET average_watts = NULL,
                   average_heartrate = NULL,
                   max_heartrate = NULL,
                   normalized_watts = NULL
             WHERE id IN (
                SELECT e.id
                  FROM efforts e
                  JOIN activities a ON a.id = e.activity_id
                 WHERE (e.average_watts IS NOT NULL
                        AND a.average_watts IS NOT NULL
                        AND e.average_watts = a.average_watts)
                    OR (e.average_heartrate IS NOT NULL
                        AND a.average_heartrate IS NOT NULL
                        AND e.average_heartrate = a.average_heartrate
                        AND e.average_watts IS NOT NULL
                        AND a.average_watts IS NOT NULL
                        AND e.average_watts = a.average_watts)
            )
            """
        )
        print(f"Cleared {conn.total_changes} contaminated effort rows")

    # 2. Recalculate efficiency for ALL efforts from their own columns
    conn.execute(
        """
        UPDATE efforts
           SET efficiency = CASE
                   WHEN average_heartrate IS NOT NULL
                        AND average_heartrate > 0
                        AND average_watts IS NOT NULL
                   THEN ROUND(average_watts / average_heartrate, 3)
                   ELSE NULL
               END
        """
    )
    print(f"Recalculated efficiency for {conn.total_changes} efforts")

    conn.commit()
    conn.close()
    print("Done. Refresh efforts in the app to re-fetch segment-level data from Strava.")


if __name__ == "__main__":
    main()
