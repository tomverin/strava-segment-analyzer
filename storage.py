import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


class StravaRepository:
    def __init__(self, db_path: str = "data/strava.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS segments (
                    id INTEGER PRIMARY KEY,
                    name TEXT,
                    distance REAL,
                    total_elevation_gain REAL,
                    city TEXT,
                    state TEXT,
                    raw_json TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER PRIMARY KEY,
                    athlete_id INTEGER NOT NULL,
                    name TEXT,
                    bike_id TEXT,
                    bike_name TEXT,
                    start_date TEXT,
                    average_heartrate REAL,
                    max_heartrate REAL,
                    average_watts REAL,
                    weighted_average_watts REAL,
                    moving_time INTEGER,
                    elapsed_time INTEGER,
                    distance REAL,
                    raw_json TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS efforts (
                    id INTEGER PRIMARY KEY,
                    segment_id INTEGER NOT NULL,
                    activity_id INTEGER NOT NULL,
                    athlete_id INTEGER NOT NULL,
                    start_date TEXT,
                    bike_id TEXT,
                    bike_name TEXT,
                    elapsed_time INTEGER,
                    moving_time INTEGER,
                    distance REAL,
                    average_heartrate REAL,
                    max_heartrate REAL,
                    average_watts REAL,
                    normalized_watts REAL,
                    efficiency REAL,
                    vam REAL,
                    name TEXT,
                    raw_json TEXT,
                    synced_at TEXT NOT NULL,
                    FOREIGN KEY(segment_id) REFERENCES segments(id),
                    FOREIGN KEY(activity_id) REFERENCES activities(id)
                );

                CREATE INDEX IF NOT EXISTS idx_efforts_segment_athlete
                ON efforts(segment_id, athlete_id);

                CREATE INDEX IF NOT EXISTS idx_efforts_activity
                ON efforts(activity_id);

                CREATE TABLE IF NOT EXISTS sync_state (
                    segment_id INTEGER NOT NULL,
                    athlete_id INTEGER NOT NULL,
                    next_page INTEGER NOT NULL DEFAULT 1,
                    full_sync_completed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (segment_id, athlete_id)
                );
                """
            )
        activity_alters = [
            "ALTER TABLE activities ADD COLUMN bike_id TEXT",
            "ALTER TABLE activities ADD COLUMN bike_name TEXT",
            "ALTER TABLE activities ADD COLUMN weighted_average_watts REAL",
        ]
        effort_alters = [
            "ALTER TABLE efforts ADD COLUMN bike_id TEXT",
            "ALTER TABLE efforts ADD COLUMN bike_name TEXT",
            "ALTER TABLE efforts ADD COLUMN normalized_watts REAL",
            "ALTER TABLE efforts ADD COLUMN efficiency REAL",
        ]

        with self._connect() as conn:
            for sql in activity_alters + effort_alters:
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError:
                    pass
        # Backfill bike info from already cached Strava activity payload.
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE activities
                SET
                    bike_id = COALESCE(bike_id, json_extract(raw_json, '$.gear_id')),
                    bike_name = COALESCE(
                        bike_name,
                        json_extract(raw_json, '$.gear.name'),
                        CASE
                            WHEN json_extract(raw_json, '$.gear_id') IS NOT NULL
                            THEN 'Bike ' || json_extract(raw_json, '$.gear_id')
                            ELSE NULL
                        END
                    )
                WHERE bike_id IS NULL OR bike_name IS NULL
                """
            )
            conn.execute(
                """
                UPDATE activities
                SET weighted_average_watts = COALESCE(weighted_average_watts, json_extract(raw_json, '$.weighted_average_watts'))
                WHERE weighted_average_watts IS NULL
                """
            )
            conn.execute(
                """
                UPDATE efforts
                SET
                    bike_id = COALESCE(
                        bike_id,
                        (SELECT a.bike_id FROM activities a WHERE a.id = efforts.activity_id)
                    ),
                    bike_name = COALESCE(
                        bike_name,
                        (SELECT a.bike_name FROM activities a WHERE a.id = efforts.activity_id),
                        CASE
                            WHEN (SELECT a.bike_id FROM activities a WHERE a.id = efforts.activity_id) IS NOT NULL
                            THEN 'Bike ' || (SELECT a.bike_id FROM activities a WHERE a.id = efforts.activity_id)
                            ELSE NULL
                        END
                    ),
                    normalized_watts = COALESCE(
                        normalized_watts,
                        (SELECT a.weighted_average_watts FROM activities a WHERE a.id = efforts.activity_id)
                    ),
                    efficiency = COALESCE(
                        efficiency,
                        CASE
                            WHEN average_heartrate IS NOT NULL AND average_heartrate > 0 THEN
                                COALESCE(
                                    normalized_watts,
                                    (SELECT a.weighted_average_watts FROM activities a WHERE a.id = efforts.activity_id),
                                    average_watts
                                ) / average_heartrate
                            ELSE NULL
                        END
                    )
                WHERE bike_id IS NULL
                   OR bike_name IS NULL
                   OR TRIM(bike_name) = ''
                   OR normalized_watts IS NULL
                   OR efficiency IS NULL
                """
            )

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def upsert_segment(self, segment: Dict) -> None:
        now = self._now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO segments (id, name, distance, total_elevation_gain, city, state, raw_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    distance=excluded.distance,
                    total_elevation_gain=excluded.total_elevation_gain,
                    city=excluded.city,
                    state=excluded.state,
                    raw_json=excluded.raw_json,
                    updated_at=excluded.updated_at
                """,
                (
                    segment.get("id"),
                    segment.get("name"),
                    segment.get("distance"),
                    segment.get("total_elevation_gain"),
                    segment.get("city"),
                    segment.get("state"),
                    json.dumps(segment),
                    now,
                ),
            )

    def get_segment(self, segment_id: int) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, distance, total_elevation_gain, city, state
                FROM segments
                WHERE id = ?
                """,
                (segment_id,),
            ).fetchone()

            if not row:
                return None
            return dict(row)

    def upsert_activities(self, athlete_id: int, activities: Dict[int, Dict]) -> None:
        if not activities:
            return

        now = self._now_iso()
        rows = []
        for activity in activities.values():
            rows.append(
                (
                    activity.get("id"),
                    athlete_id,
                    activity.get("name"),
                    activity.get("gear_id"),
                    activity.get("gear", {}).get("name")
                    or (f"Bike {activity.get('gear_id')}" if activity.get("gear_id") else None),
                    activity.get("start_date"),
                    activity.get("average_heartrate"),
                    activity.get("max_heartrate"),
                    activity.get("average_watts"),
                    activity.get("weighted_average_watts"),
                    activity.get("moving_time"),
                    activity.get("elapsed_time"),
                    activity.get("distance"),
                    json.dumps(activity),
                    now,
                )
            )

        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO activities (
                    id, athlete_id, name, bike_id, bike_name, start_date, average_heartrate, max_heartrate,
                    average_watts, weighted_average_watts, moving_time, elapsed_time, distance, raw_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    athlete_id=excluded.athlete_id,
                    name=excluded.name,
                    bike_id=COALESCE(excluded.bike_id, activities.bike_id),
                    bike_name=COALESCE(excluded.bike_name, activities.bike_name),
                    start_date=excluded.start_date,
                    average_heartrate=excluded.average_heartrate,
                    max_heartrate=excluded.max_heartrate,
                    average_watts=excluded.average_watts,
                    weighted_average_watts=COALESCE(excluded.weighted_average_watts, activities.weighted_average_watts),
                    moving_time=excluded.moving_time,
                    elapsed_time=excluded.elapsed_time,
                    distance=excluded.distance,
                    raw_json=excluded.raw_json,
                    updated_at=excluded.updated_at
                """,
                rows,
            )

    def upsert_efforts(self, segment_id: int, athlete_id: int, efforts: List[Dict]) -> None:
        now = self._now_iso()
        if not efforts:
            return

        rows = [
            (
                effort.get("id"),
                segment_id,
                effort.get("activity_id"),
                athlete_id,
                effort.get("start_date"),
                effort.get("bike_id"),
                effort.get("bike_name"),
                effort.get("elapsed_time"),
                effort.get("moving_time"),
                effort.get("distance"),
                effort.get("average_heartrate"),
                effort.get("max_heartrate"),
                effort.get("average_watts"),
                effort.get("normalized_watts"),
                effort.get("efficiency"),
                effort.get("vam"),
                effort.get("name", "Untitled"),
                json.dumps(effort),
                now,
            )
            for effort in efforts
        ]

        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO efforts (
                    id, segment_id, activity_id, athlete_id, start_date, bike_id, bike_name, elapsed_time,
                    moving_time, distance, average_heartrate, max_heartrate, average_watts,
                    normalized_watts, efficiency, vam, name, raw_json, synced_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    segment_id=excluded.segment_id,
                    activity_id=excluded.activity_id,
                    athlete_id=excluded.athlete_id,
                    start_date=excluded.start_date,
                    bike_id=COALESCE(excluded.bike_id, efforts.bike_id),
                    bike_name=COALESCE(excluded.bike_name, efforts.bike_name),
                    elapsed_time=excluded.elapsed_time,
                    moving_time=excluded.moving_time,
                    distance=excluded.distance,
                    average_heartrate=excluded.average_heartrate,
                    max_heartrate=excluded.max_heartrate,
                    average_watts=excluded.average_watts,
                    normalized_watts=COALESCE(excluded.normalized_watts, efforts.normalized_watts),
                    efficiency=COALESCE(excluded.efficiency, efforts.efficiency),
                    vam=excluded.vam,
                    name=excluded.name,
                    raw_json=excluded.raw_json,
                    synced_at=excluded.synced_at
                """,
                rows,
            )

    def get_activities_by_ids(self, activity_ids: List[int]) -> Dict[int, Dict]:
        if not activity_ids:
            return {}

        placeholders = ",".join("?" for _ in activity_ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    id, name, bike_id, bike_name, start_date, average_heartrate, max_heartrate, average_watts,
                    weighted_average_watts,
                    moving_time, elapsed_time, distance
                FROM activities
                WHERE id IN ({placeholders})
                """,
                activity_ids,
            ).fetchall()

        return {row["id"]: dict(row) for row in rows}

    def get_missing_bike_activity_ids(self, segment_id: int, athlete_id: int, limit: int = 100) -> List[int]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT DISTINCT e.activity_id
                FROM efforts e
                LEFT JOIN activities a ON a.id = e.activity_id
                WHERE e.segment_id = ?
                  AND e.athlete_id = ?
                  AND (a.id IS NULL OR a.bike_name IS NULL OR TRIM(a.bike_name) = '')
                ORDER BY e.start_date DESC
                LIMIT ?
                """,
                (segment_id, athlete_id, limit),
            ).fetchall()
        return [row["activity_id"] for row in rows]

    def get_sync_state(self, segment_id: int, athlete_id: int) -> Dict:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT next_page, full_sync_completed, updated_at
                FROM sync_state
                WHERE segment_id = ? AND athlete_id = ?
                """,
                (segment_id, athlete_id),
            ).fetchone()

        if not row:
            return {"next_page": 1, "full_sync_completed": False, "updated_at": None}

        return {
            "next_page": row["next_page"],
            "full_sync_completed": bool(row["full_sync_completed"]),
            "updated_at": row["updated_at"],
        }

    def upsert_sync_state(
        self,
        segment_id: int,
        athlete_id: int,
        next_page: int,
        full_sync_completed: bool,
    ) -> None:
        now = self._now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sync_state (segment_id, athlete_id, next_page, full_sync_completed, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(segment_id, athlete_id) DO UPDATE SET
                    next_page=excluded.next_page,
                    full_sync_completed=excluded.full_sync_completed,
                    updated_at=excluded.updated_at
                """,
                (segment_id, athlete_id, next_page, 1 if full_sync_completed else 0, now),
            )

    def get_efforts(self, segment_id: int, athlete_id: int) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    id, start_date, bike_id, bike_name, elapsed_time, moving_time, distance,
                    average_heartrate, max_heartrate, average_watts, normalized_watts, efficiency, vam, name, activity_id
                FROM efforts
                WHERE segment_id = ? AND athlete_id = ?
                ORDER BY start_date DESC
                """,
                (segment_id, athlete_id),
            ).fetchall()

            return [dict(row) for row in rows]

    def clear_all(self) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM efforts")
            conn.execute("DELETE FROM activities")
            conn.execute("DELETE FROM segments")
            conn.execute("DELETE FROM sync_state")

    def stats(self, segment_id: Optional[int] = None, athlete_id: Optional[int] = None) -> Dict:
        with self._connect() as conn:
            segment_count = conn.execute("SELECT COUNT(*) AS c FROM segments").fetchone()["c"]
            activity_count = conn.execute("SELECT COUNT(*) AS c FROM activities").fetchone()["c"]
            effort_count = conn.execute("SELECT COUNT(*) AS c FROM efforts").fetchone()["c"]
            segment_effort_count = None
            segment_activity_count = None
            sync_state = None

            if segment_id is not None and athlete_id is not None:
                segment_effort_count = conn.execute(
                    """
                    SELECT COUNT(*) AS c
                    FROM efforts
                    WHERE segment_id = ? AND athlete_id = ?
                    """,
                    (segment_id, athlete_id),
                ).fetchone()["c"]

                segment_activity_count = conn.execute(
                    """
                    SELECT COUNT(DISTINCT activity_id) AS c
                    FROM efforts
                    WHERE segment_id = ? AND athlete_id = ?
                    """,
                    (segment_id, athlete_id),
                ).fetchone()["c"]

                enriched_activity_count = conn.execute(
                    """
                    SELECT COUNT(DISTINCT e.activity_id) AS c
                    FROM efforts e
                    JOIN activities a ON a.id = e.activity_id
                    WHERE e.segment_id = ? AND e.athlete_id = ?
                    """,
                    (segment_id, athlete_id),
                ).fetchone()["c"]

                sync_row = conn.execute(
                    """
                    SELECT next_page, full_sync_completed, updated_at
                    FROM sync_state
                    WHERE segment_id = ? AND athlete_id = ?
                    """,
                    (segment_id, athlete_id),
                ).fetchone()
                if sync_row:
                    sync_state = {
                        "next_page": sync_row["next_page"],
                        "full_sync_completed": bool(sync_row["full_sync_completed"]),
                        "updated_at": sync_row["updated_at"],
                    }

        size = self.db_path.stat().st_size if self.db_path.exists() else 0
        total = segment_count + activity_count + effort_count

        stats = {
            "total_files": total,
            "by_type": {
                "segment": segment_count,
                "activity": activity_count,
                "streams": 0,
                "efforts": effort_count,
            },
            "total_size": size,
            "db_path": str(self.db_path),
        }
        if segment_id is not None and athlete_id is not None:
            stats["segment_scope"] = {
                "segment_id": segment_id,
                "athlete_id": athlete_id,
                "effort_count": segment_effort_count or 0,
                "activity_count": segment_activity_count or 0,
                "enriched_activity_count": enriched_activity_count or 0,
                "missing_activity_count": max(
                    0,
                    (segment_activity_count or 0) - (enriched_activity_count or 0),
                ),
                "sync_state": sync_state,
            }
        return stats
