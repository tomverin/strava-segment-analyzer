import json
import logging
import os
import time
from typing import Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, session, url_for

from storage import StravaRepository


load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "fallback-secret-key-for-cloud-deployment")

STRAVA_CLIENT_ID = os.getenv("STRAVA_CLIENT_ID")
STRAVA_CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET")
STRAVA_REDIRECT_URI = os.getenv("STRAVA_REDIRECT_URI", "http://localhost:8000/auth/callback")
STRAVA_API_BASE = "https://www.strava.com/api/v3"
STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
RECENT_REFRESH_PAGES = max(1, int(os.getenv("RECENT_REFRESH_PAGES", "2")))
BACKFILL_PAGES_PER_RUN = max(1, int(os.getenv("BACKFILL_PAGES_PER_RUN", "25")))
MAX_ACTIVITY_FETCHES_PER_PAGE = max(1, int(os.getenv("MAX_ACTIVITY_FETCHES_PER_PAGE", "25")))
RATE_LIMIT_COOLDOWN_SECONDS = max(60, int(os.getenv("RATE_LIMIT_COOLDOWN_SECONDS", "900")))
MAX_MISSING_BIKE_REFRESH_PER_RUN = max(1, int(os.getenv("MAX_MISSING_BIKE_REFRESH_PER_RUN", "40")))

repository = StravaRepository(os.getenv("STRAVA_DB_PATH", "data/strava.db"))
rate_limit_cooldowns: Dict[str, float] = {}
logger.info(
    "Sync config db_path=%s recent_refresh_pages=%s backfill_pages_per_run=%s max_activity_fetches_per_page=%s max_missing_bike_refresh_per_run=%s rate_limit_cooldown_seconds=%s",
    repository.db_path,
    RECENT_REFRESH_PAGES,
    BACKFILL_PAGES_PER_RUN,
    MAX_ACTIVITY_FETCHES_PER_PAGE,
    MAX_MISSING_BIKE_REFRESH_PER_RUN,
    RATE_LIMIT_COOLDOWN_SECONDS,
)


class StravaAPIError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


def parse_strava_error_response(response_text: str, status_code: int) -> str:
    """Parse Strava API error JSON into a user-friendly message."""
    if not response_text or not response_text.strip().startswith("{"):
        return "Strava API request failed" if status_code != 200 else response_text[:200]
    try:
        data = json.loads(response_text)
        msg = data.get("message", "")
        errors = data.get("errors", [])
        if status_code == 429:
            return "Strava rate limit exceeded. Please try again in 15–20 minutes."
        if msg and errors:
            return f"{msg}"
        if msg:
            return msg
        if errors and isinstance(errors, list) and errors:
            first = errors[0]
            if isinstance(first, dict) and first.get("field"):
                return f"Strava API error: {first.get('field', '')}"
        return response_text[:200]
    except (json.JSONDecodeError, TypeError):
        return response_text[:200] if response_text else "Strava API request failed"


def normalize_athlete_id(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def cooldown_key(segment_id: int, athlete_id: int) -> str:
    return f"{segment_id}:{athlete_id}"


def get_cooldown_remaining_seconds(segment_id: int, athlete_id: int) -> int:
    key = cooldown_key(segment_id, athlete_id)
    until = rate_limit_cooldowns.get(key, 0)
    remaining = int(until - time.time())
    return max(0, remaining)


def set_rate_limit_cooldown(segment_id: int, athlete_id: int) -> None:
    key = cooldown_key(segment_id, athlete_id)
    rate_limit_cooldowns[key] = time.time() + RATE_LIMIT_COOLDOWN_SECONDS
    logger.warning(
        "Set rate-limit cooldown segment=%s athlete=%s for %ss",
        segment_id,
        athlete_id,
        RATE_LIMIT_COOLDOWN_SECONDS,
    )


def add_cache_headers(response, max_age=300):
    response.headers["Cache-Control"] = f"private, max-age={max_age}"
    response.headers["Vary"] = "Accept-Encoding"
    return response


def refresh_access_token() -> bool:
    logger.info("Refreshing Strava access token")
    refresh_token = session.get("refresh_token")
    if not refresh_token or not STRAVA_CLIENT_ID or not STRAVA_CLIENT_SECRET:
        logger.warning("Cannot refresh token: missing refresh token or client credentials")
        return False

    payload = {
        "client_id": STRAVA_CLIENT_ID,
        "client_secret": STRAVA_CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    response = requests.post(STRAVA_TOKEN_URL, data=payload, timeout=20)
    if response.status_code != 200:
        logger.warning("Failed refreshing token: %s", response.text)
        return False

    token_info = response.json()
    if "access_token" not in token_info or "refresh_token" not in token_info:
        logger.warning("Refresh response missing token fields: %s", token_info)
        return False

    session["access_token"] = token_info["access_token"]
    session["refresh_token"] = token_info["refresh_token"]

    athlete = token_info.get("athlete")
    if isinstance(athlete, dict) and athlete.get("id"):
        session["athlete_id"] = athlete["id"]
        logger.info("Access token refreshed successfully for athlete=%s", session["athlete_id"])
        return True

    # Some refresh responses may not include athlete details.
    if session.get("athlete_id"):
        logger.info("Access token refreshed; reusing athlete_id from session=%s", session["athlete_id"])
        return True

    try:
        headers = {"Authorization": f"Bearer {session['access_token']}"}
        athlete_response = requests.get(
            f"{STRAVA_API_BASE}/athlete", headers=headers, timeout=20
        )
        if athlete_response.status_code == 200:
            athlete_data = athlete_response.json()
            athlete_id = athlete_data.get("id")
            if athlete_id:
                session["athlete_id"] = athlete_id
                logger.info("Access token refreshed; athlete_id loaded from /athlete=%s", athlete_id)
                return True
        logger.warning(
            "Unable to resolve athlete_id after token refresh: %s",
            athlete_response.text,
        )
    except requests.exceptions.RequestException as exc:
        logger.warning("Failed to fetch athlete profile after refresh: %s", exc)
        return False

    return False


def strava_get(path: str, params: Dict | None = None, retry_on_auth=True):
    if "access_token" not in session:
        raise StravaAPIError(401, "Not authenticated")

    headers = {"Authorization": f"Bearer {session['access_token']}"}
    url = f"{STRAVA_API_BASE}{path}"
    started = time.time()
    response = requests.get(url, headers=headers, params=params, timeout=30)
    duration_ms = int((time.time() - started) * 1000)
    logger.info(
        "Strava GET %s status=%s duration_ms=%s params=%s",
        path,
        response.status_code,
        duration_ms,
        params or {},
    )

    if response.status_code == 401 and retry_on_auth:
        logger.warning("Strava auth expired on %s, attempting token refresh", path)
        if refresh_access_token():
            logger.info("Retrying Strava GET %s after token refresh", path)
            return strava_get(path, params=params, retry_on_auth=False)
        session.clear()
        raise StravaAPIError(401, "Authentication expired. Please login again.")

    if response.status_code != 200:
        details = parse_strava_error_response(
            response.text or "", response.status_code
        )
        raise StravaAPIError(response.status_code, details)

    return response.json()


def fetch_efforts_page(segment_id: int, page: int, athlete_id: int) -> List[Dict]:
    logger.info("Requesting efforts page=%s segment=%s", page, segment_id)
    params = {"per_page": 200, "page": page, "athlete_id": athlete_id}
    try:
        page_data = strava_get(f"/segments/{segment_id}/all_efforts", params=params)
    except StravaAPIError as exc:
        # Fallback: some apps may not have athlete_id filtering enabled.
        if exc.status_code == 400:
            logger.warning(
                "Strava did not accept athlete_id filter for efforts page=%s segment=%s, retrying without it",
                page,
                segment_id,
            )
            page_data = strava_get(
                f"/segments/{segment_id}/all_efforts",
                params={"per_page": 200, "page": page},
            )
        else:
            raise
    logger.info("Fetched efforts page=%s count=%s segment=%s", page, len(page_data), segment_id)
    return page_data


def build_effort_payload(segment: Dict, raw_efforts: List[Dict], activities: Dict[int, Dict]) -> List[Dict]:
    elevation_gain = segment.get("total_elevation_gain") or 0
    prepared = []

    for effort in raw_efforts:
        activity_id = effort.get("activity", {}).get("id")
        if not activity_id:
            continue

        activity = activities.get(activity_id, {})
        elapsed = effort.get("elapsed_time") or 0

        vam = None
        if elevation_gain and elapsed:
            vam = round((float(elevation_gain) / elapsed) * 3600, 0)

        prepared.append(
            {
                "id": effort.get("id"),
                "start_date": effort.get("start_date"),
                "bike_id": activity.get("bike_id") or activity.get("gear_id"),
                "bike_name": activity.get("bike_name")
                or activity.get("gear", {}).get("name")
                or (f"Bike {activity.get('gear_id')}" if activity.get("gear_id") else "Unknown"),
                "elapsed_time": elapsed,
                "moving_time": effort.get("moving_time") or elapsed,
                "distance": effort.get("distance") or 0,
                "average_heartrate": effort.get("average_heartrate") or activity.get("average_heartrate"),
                "max_heartrate": effort.get("max_heartrate") or activity.get("max_heartrate"),
                "average_watts": effort.get("average_watts") or activity.get("average_watts"),
                "normalized_watts": effort.get("weighted_average_watts")
                or activity.get("weighted_average_watts"),
                "efficiency": None,
                "vam": vam,
                "name": activity.get("name") or f"Activity {activity_id}",
                "activity_id": activity_id,
            }
        )

        current = prepared[-1]
        avg_hr = current.get("average_heartrate")
        if avg_hr and avg_hr > 0:
            np_watts = current.get("normalized_watts")
            fallback_watts = current.get("average_watts")
            selected_watts = np_watts if np_watts is not None else fallback_watts
            if selected_watts is not None:
                current["efficiency"] = round(float(selected_watts) / float(avg_hr), 3)

    prepared.sort(key=lambda x: x.get("start_date") or "", reverse=True)
    logger.info(
        "Prepared effort payload count=%s segment=%s",
        len(prepared),
        segment.get("id"),
    )
    return prepared


def compute_decoupling(efforts: List[Dict]) -> None:
    """Add decoupling_pct to efforts from the same activity with 2+ efforts.

    Decoupling % = (EF1 - EF2) / EF1 × 100 (Pw:HR drift)
    EF = efficiency factor = normalized_watts / avg_heartrate (or average_watts fallback)

    For 2 efforts: (EF_first - EF_last) / EF_first × 100
    For 3+ efforts: average of consecutive decouplings between all pairs.
    """
    from collections import defaultdict

    by_activity: Dict[int, List[Dict]] = defaultdict(list)
    for e in efforts:
        aid = e.get("activity_id")
        if aid:
            by_activity[aid].append(e)

    for group in by_activity.values():
        if len(group) < 2:
            continue

        group_sorted = sorted(group, key=lambda x: x.get("start_date") or "")

        def get_ef(effort: Dict) -> Optional[float]:
            ef = effort.get("efficiency")
            if ef is not None:
                return float(ef)
            hr = effort.get("average_heartrate")
            wat = effort.get("normalized_watts") or effort.get("average_watts")
            if hr and hr > 0 and wat is not None:
                return float(wat) / float(hr)
            return None

        efs = [(e, get_ef(e)) for e in group_sorted]
        efs = [(e, ef) for e, ef in efs if ef is not None and ef > 0]

        if len(efs) < 2:
            continue

        decouplings = []
        for i in range(len(efs) - 1):
            ef_curr = efs[i][1]
            ef_next = efs[i + 1][1]
            if ef_curr > 0:
                decouplings.append((ef_curr - ef_next) / ef_curr * 100)

        if not decouplings:
            continue

        decoupling_pct = round(sum(decouplings) / len(decouplings), 1)
        for e in group:
            e["decoupling_pct"] = decoupling_pct


def refresh_missing_bike_activities(segment_id: int, athlete_id: int) -> int:
    missing_activity_ids = repository.get_missing_bike_activity_ids(
        segment_id=segment_id,
        athlete_id=athlete_id,
        limit=MAX_MISSING_BIKE_REFRESH_PER_RUN,
    )
    if not missing_activity_ids:
        return 0

    logger.info(
        "Refreshing missing bike metadata for segment=%s athlete=%s count=%s",
        segment_id,
        athlete_id,
        len(missing_activity_ids),
    )

    refreshed: Dict[int, Dict] = {}
    for idx, activity_id in enumerate(missing_activity_ids, start=1):
        try:
            refreshed[activity_id] = strava_get(f"/activities/{activity_id}")
        except StravaAPIError as exc:
            if exc.status_code == 429:
                logger.warning(
                    "Rate limited while refreshing bike metadata at activity=%s progress=%s/%s",
                    activity_id,
                    idx,
                    len(missing_activity_ids),
                )
                break
            raise
        if idx % 20 == 0 or idx == len(missing_activity_ids):
            logger.info(
                "Bike metadata refresh progress=%s/%s",
                idx,
                len(missing_activity_ids),
            )
        if idx % 20 == 0:
            time.sleep(0.3)

    if refreshed:
        repository.upsert_activities(athlete_id, refreshed)
    return len(refreshed)


def sync_efforts_page(segment: Dict, athlete_id: int, page_data: List[Dict], page: int) -> Tuple[int, bool]:
    athlete_id_int = normalize_athlete_id(athlete_id)
    athlete_efforts = [
        effort
        for effort in page_data
        if normalize_athlete_id(effort.get("athlete", {}).get("id")) == athlete_id_int
    ]
    logger.info(
        "Page %s filtered for athlete=%s count=%s/%s",
        page,
        athlete_id_int,
        len(athlete_efforts),
        len(page_data),
    )
    if page_data and not athlete_efforts:
        sample_ids = sorted(
            {
                normalize_athlete_id(effort.get("athlete", {}).get("id"))
                for effort in page_data[:10]
            }
        )
        logger.warning(
            "Page %s returned no matching athlete efforts for athlete=%s sample_athlete_ids=%s",
            page,
            athlete_id_int,
            sample_ids,
        )

    # Keep activities ordered by the recency of their associated efforts.
    latest_effort_date_by_activity: Dict[int, str] = {}
    for effort in athlete_efforts:
        activity_id = effort.get("activity", {}).get("id")
        if not activity_id:
            continue
        start_date = effort.get("start_date") or ""
        previous = latest_effort_date_by_activity.get(activity_id, "")
        if start_date > previous:
            latest_effort_date_by_activity[activity_id] = start_date

    activity_ids = sorted(
        latest_effort_date_by_activity.keys(),
        key=lambda activity_id: latest_effort_date_by_activity.get(activity_id, ""),
        reverse=True,
    )

    existing_activities = repository.get_activities_by_ids(activity_ids)
    missing_activity_ids = [activity_id for activity_id in activity_ids if activity_id not in existing_activities]
    logger.info(
        "Page %s activity details: total=%s existing=%s missing=%s",
        page,
        len(activity_ids),
        len(existing_activities),
        len(missing_activity_ids),
    )

    # Persist page efforts immediately so UI can display data even if enrichment is interrupted.
    base_payload = build_effort_payload(segment, athlete_efforts, {})
    repository.upsert_efforts(segment_id=segment["id"], athlete_id=athlete_id_int, efforts=base_payload)
    rows_written = len(base_payload)
    logger.info("Page %s stored base effort rows=%s before activity enrichment", page, rows_written)

    fetched_activities: Dict[int, Dict] = {}
    rate_limited = False
    activity_ids_to_fetch = missing_activity_ids[:MAX_ACTIVITY_FETCHES_PER_PAGE]
    if len(missing_activity_ids) > len(activity_ids_to_fetch):
        logger.info(
            "Page %s limiting activity enrichment to %s/%s this run",
            page,
            len(activity_ids_to_fetch),
            len(missing_activity_ids),
        )

    for idx, activity_id in enumerate(activity_ids_to_fetch, start=1):
        try:
            fetched_activities[activity_id] = strava_get(f"/activities/{activity_id}")
        except StravaAPIError as exc:
            if exc.status_code == 429:
                rate_limited = True
                logger.warning(
                    "Rate limited while enriching page=%s at activity=%s progress=%s/%s",
                    page,
                    activity_id,
                    idx,
                    len(activity_ids_to_fetch),
                )
                break
            raise
        if idx % 20 == 0 or idx == len(activity_ids_to_fetch):
            logger.info(
                "Page %s fetched missing activity details progress=%s/%s",
                page,
                idx,
                len(activity_ids_to_fetch),
            )
        if idx % 20 == 0:
            time.sleep(0.3)

    if fetched_activities:
        repository.upsert_activities(athlete_id_int, fetched_activities)

    all_activities = {**existing_activities, **fetched_activities}
    effort_payload = build_effort_payload(segment, athlete_efforts, all_activities)
    repository.upsert_efforts(segment_id=segment["id"], athlete_id=athlete_id_int, efforts=effort_payload)
    logger.info(
        "Page %s updated enriched effort rows=%s fetched_activities=%s rate_limited=%s",
        page,
        len(effort_payload),
        len(fetched_activities),
        rate_limited,
    )
    return rows_written, rate_limited


def sync_segment_batch(segment_id: int, athlete_id: int) -> List[Dict]:
    athlete_id_int = normalize_athlete_id(athlete_id)
    if athlete_id_int is None:
        raise StravaAPIError(401, "Invalid athlete id in session. Please login again.")

    logger.info("Starting batch sync for segment=%s athlete=%s", segment_id, athlete_id_int)

    segment = strava_get(f"/segments/{segment_id}")
    repository.upsert_segment(segment)
    logger.info(
        "Segment metadata stored id=%s name=%s distance=%.2fkm",
        segment.get("id"),
        segment.get("name"),
        (segment.get("distance") or 0) / 1000,
    )

    sync_state = repository.get_sync_state(segment_id, athlete_id_int)
    logger.info(
        "Current sync state segment=%s athlete=%s next_page=%s full_sync_completed=%s",
        segment_id,
        athlete_id_int,
        sync_state["next_page"],
        sync_state["full_sync_completed"],
    )

    total_rows_written = 0
    reached_end = False

    logger.info("Recent refresh phase pages=1..%s", RECENT_REFRESH_PAGES)
    for page in range(1, RECENT_REFRESH_PAGES + 1):
        page_data = fetch_efforts_page(segment_id, page, athlete_id_int)
        if not page_data:
            reached_end = True
            logger.info("Reached end of efforts during recent refresh at page=%s", page)
            break

        page_rows, page_rate_limited = sync_efforts_page(segment, athlete_id_int, page_data, page)
        total_rows_written += page_rows
        if page_rate_limited:
            logger.warning("Stopping sync early after rate-limit in recent phase at page=%s", page)
            break
        if len(page_data) < 200:
            reached_end = True
            logger.info("Reached final efforts page during recent refresh at page=%s", page)
            break
        time.sleep(0.15)

    if reached_end:
        repository.upsert_sync_state(segment_id, athlete_id_int, next_page=1, full_sync_completed=True)
    else:
        start_page = max(sync_state["next_page"], RECENT_REFRESH_PAGES + 1)
        logger.info(
            "Backfill phase start_page=%s max_pages_this_run=%s",
            start_page,
            BACKFILL_PAGES_PER_RUN,
        )

        page = start_page
        processed_pages = 0
        while processed_pages < BACKFILL_PAGES_PER_RUN:
            page_data = fetch_efforts_page(segment_id, page, athlete_id_int)
            if not page_data:
                reached_end = True
                logger.info("Reached end of efforts during backfill at page=%s", page)
                break

            page_rows, page_rate_limited = sync_efforts_page(segment, athlete_id_int, page_data, page)
            total_rows_written += page_rows
            processed_pages += 1

            if page_rate_limited:
                logger.warning("Stopping sync early after rate-limit in backfill at page=%s", page)
                break

            if len(page_data) < 200:
                reached_end = True
                logger.info("Reached final efforts page during backfill at page=%s", page)
                break

            page += 1
            repository.upsert_sync_state(segment_id, athlete_id_int, next_page=page, full_sync_completed=False)
            time.sleep(0.15)

        if reached_end:
            repository.upsert_sync_state(segment_id, athlete_id_int, next_page=1, full_sync_completed=True)
        else:
            repository.upsert_sync_state(segment_id, athlete_id_int, next_page=page, full_sync_completed=False)
            logger.info("Backfill paused, next run will resume from page=%s", page)

    effort_payload = repository.get_efforts(segment_id, athlete_id_int)
    bike_refresh_count = refresh_missing_bike_activities(segment_id, athlete_id_int)
    if bike_refresh_count:
        effort_payload = repository.get_efforts(segment_id, athlete_id_int)

    logger.info(
        "Batch sync complete for segment=%s athlete=%s total_efforts_now=%s rows_written_this_run=%s bike_activities_refreshed=%s",
        segment_id,
        athlete_id_int,
        len(effort_payload),
        total_rows_written,
        bike_refresh_count,
    )
    return effort_payload


@app.route("/")
def index():
    if "access_token" not in session:
        return redirect(url_for("login"))
    return render_template("index.html")


@app.route("/login")
def login():
    if not STRAVA_CLIENT_ID:
        return "Configuration Error: STRAVA_CLIENT_ID not set.", 500

    auth_url = (
        f"{STRAVA_AUTH_URL}?client_id={STRAVA_CLIENT_ID}"
        f"&response_type=code&redirect_uri={STRAVA_REDIRECT_URI}"
        "&approval_prompt=force&scope=read,activity:read_all"
    )
    return redirect(auth_url)


@app.route("/auth/callback")
def auth_callback():
    code = request.args.get("code")
    error = request.args.get("error")

    if error:
        return f"Authorization failed: {error}", 400
    if not code:
        return "Authorization failed - no code received", 400

    payload = {
        "client_id": STRAVA_CLIENT_ID,
        "client_secret": STRAVA_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
    }
    response = requests.post(STRAVA_TOKEN_URL, data=payload, timeout=20)

    if response.status_code != 200:
        return f"Token exchange failed: {response.text}", 400

    token_info = response.json()
    session["access_token"] = token_info["access_token"]
    session["refresh_token"] = token_info["refresh_token"]
    session["athlete_id"] = token_info["athlete"]["id"]
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/segment/<int:segment_id>/sync", methods=["POST"])
def sync_segment(segment_id):
    if "access_token" not in session:
        return jsonify({"error": "Not authenticated"}), 401

    athlete_id = session.get("athlete_id")
    athlete_id_int = normalize_athlete_id(athlete_id)
    if athlete_id_int is None:
        session.clear()
        return jsonify({"error": "Session athlete id missing/invalid", "needs_reauth": True}), 401

    cooldown_remaining = get_cooldown_remaining_seconds(segment_id, athlete_id_int)
    if cooldown_remaining > 0:
        return (
            jsonify(
                {
                    "error": "Rate limited by Strava. Please retry later.",
                    "retry_after_seconds": cooldown_remaining,
                }
            ),
            429,
        )

    try:
        efforts = sync_segment_batch(segment_id, athlete_id_int)
        return jsonify({"message": "Sync completed", "effort_count": len(efforts)})
    except StravaAPIError as exc:
        if exc.status_code == 401:
            return jsonify({"error": exc.message, "needs_reauth": True}), 401
        if exc.status_code == 429:
            set_rate_limit_cooldown(segment_id, athlete_id_int)
            return (
                jsonify(
                    {
                        "error": "Rate limited by Strava. Please retry later.",
                        "retry_after_seconds": RATE_LIMIT_COOLDOWN_SECONDS,
                    }
                ),
                429,
            )
        return jsonify({"error": f"Sync failed: {exc.message}"}), exc.status_code
    except requests.exceptions.RequestException:
        return jsonify({"error": "Failed to connect to Strava API"}), 502


@app.route("/segment/<int:segment_id>/efforts")
def get_segment_efforts(segment_id):
    if "access_token" not in session:
        return jsonify({"error": "Not authenticated"}), 401

    athlete_id = session.get("athlete_id")
    athlete_id_int = normalize_athlete_id(athlete_id)
    if athlete_id_int is None:
        session.clear()
        return jsonify({"error": "Session athlete id missing/invalid", "needs_reauth": True}), 401

    force_refresh = request.args.get("refresh", "false").lower() == "true"
    logger.info(
        "Efforts requested segment=%s athlete=%s force_refresh=%s",
        segment_id,
        athlete_id_int,
        force_refresh,
    )

    efforts = repository.get_efforts(segment_id, athlete_id_int)
    logger.info("DB lookup returned efforts=%s segment=%s athlete=%s", len(efforts), segment_id, athlete_id_int)

    if force_refresh or not efforts:
        cooldown_remaining = get_cooldown_remaining_seconds(segment_id, athlete_id_int)
        if cooldown_remaining > 0:
            if efforts:
                logger.warning(
                    "Cooldown active; returning cached efforts count=%s remaining=%ss",
                    len(efforts),
                    cooldown_remaining,
                )
                compute_decoupling(efforts)
                return add_cache_headers(jsonify(efforts))
            return (
                jsonify(
                    {
                        "error": "Rate limited by Strava. Please retry later.",
                        "retry_after_seconds": cooldown_remaining,
                    }
                ),
                429,
            )

        reason = "force_refresh" if force_refresh else "db_empty"
        logger.info("Running sync for segment=%s athlete=%s reason=%s", segment_id, athlete_id_int, reason)
        try:
            efforts = sync_segment_batch(segment_id, athlete_id_int)
        except StravaAPIError as exc:
            if exc.status_code == 401:
                return jsonify({"error": exc.message, "needs_reauth": True}), 401
            if exc.status_code == 429:
                set_rate_limit_cooldown(segment_id, athlete_id_int)
                partial_efforts = repository.get_efforts(segment_id, athlete_id_int)
                if partial_efforts:
                    logger.warning(
                        "Rate limited during sync; returning partial DB efforts count=%s",
                        len(partial_efforts),
                    )
                    compute_decoupling(partial_efforts)
                    return add_cache_headers(jsonify(partial_efforts))
                return (
                    jsonify(
                        {
                            "error": "Rate limited by Strava. Please retry later.",
                            "retry_after_seconds": RATE_LIMIT_COOLDOWN_SECONDS,
                        }
                    ),
                    429,
                )
            return jsonify({"error": f"Failed to fetch efforts: {exc.message}"}), exc.status_code
        except requests.exceptions.RequestException:
            if efforts:
                logger.warning("Strava unavailable, returning stale DB efforts count=%s", len(efforts))
                compute_decoupling(efforts)
                return add_cache_headers(jsonify(efforts))
            return jsonify({"error": "Failed to connect to Strava API"}), 502
    else:
        # Opportunistic bike enrichment for previously synced efforts.
        cooldown_remaining = get_cooldown_remaining_seconds(segment_id, athlete_id_int)
        if cooldown_remaining == 0:
            try:
                refreshed_bikes = refresh_missing_bike_activities(segment_id, athlete_id_int)
                if refreshed_bikes:
                    logger.info(
                        "Refreshed missing bike metadata during read path count=%s",
                        refreshed_bikes,
                    )
                    efforts = repository.get_efforts(segment_id, athlete_id_int)
            except StravaAPIError as exc:
                if exc.status_code == 429:
                    set_rate_limit_cooldown(segment_id, athlete_id_int)
                elif exc.status_code == 401:
                    return jsonify({"error": exc.message, "needs_reauth": True}), 401

    logger.info("Returning efforts response count=%s segment=%s athlete=%s", len(efforts), segment_id, athlete_id_int)
    compute_decoupling(efforts)
    return add_cache_headers(jsonify(efforts))


@app.route("/segment/<int:segment_id>")
def segment_analyzer(segment_id):
    if "access_token" not in session:
        return redirect(url_for("login"))

    segment = repository.get_segment(segment_id)
    if segment is None:
        logger.info("Segment %s not found in DB, fetching from Strava", segment_id)
        try:
            segment = strava_get(f"/segments/{segment_id}")
            repository.upsert_segment(segment)
            segment = repository.get_segment(segment_id)
        except StravaAPIError as exc:
            if exc.status_code == 401:
                session.clear()
                return redirect(url_for("login"))
            if exc.status_code == 429:
                return (
                    render_template(
                        "error.html",
                        title="Rate limit exceeded",
                        message=exc.message,
                        segment_id=segment_id,
                        is_rate_limit=True,
                        retry_after_seconds=900,
                    ),
                    429,
                )
            if exc.status_code == 404:
                return (
                    render_template(
                        "error.html",
                        title="Segment not found",
                        message="This segment doesn't exist or you don't have access to it.",
                        segment_id=None,
                        is_rate_limit=False,
                    ),
                    404,
                )
            return (
                render_template(
                    "error.html",
                    title="Unable to load segment",
                    message=exc.message,
                    segment_id=segment_id,
                    is_rate_limit=False,
                ),
                exc.status_code,
            )
    else:
        logger.info("Segment %s loaded from DB", segment_id)

    return render_template("segment_analyzer.html", segment=segment)


@app.route("/db/stats")
@app.route("/cache/stats")
def db_stats():
    if "access_token" not in session:
        return jsonify({"error": "Not authenticated"}), 401
    athlete_id_int = normalize_athlete_id(session.get("athlete_id"))
    segment_id = request.args.get("segment_id", type=int)
    if segment_id is not None and athlete_id_int is not None:
        return jsonify(repository.stats(segment_id=segment_id, athlete_id=athlete_id_int))
    return jsonify(repository.stats())


@app.route("/db/clear", methods=["POST"])
@app.route("/cache/clear", methods=["POST"])
def clear_db():
    if "access_token" not in session:
        return jsonify({"error": "Not authenticated"}), 401

    payload = request.get_json(silent=True) or {}
    confirm_text = payload.get("confirm_text") or request.form.get("confirm_text")
    if confirm_text != "CLEAR":
        return jsonify({"error": "Confirmation required to clear database"}), 400

    repository.clear_all()
    return jsonify({"message": "All database entries cleared"})


@app.route("/health")
def health_check():
    return jsonify(
        {
            "status": "healthy",
            "strava_client_id_set": bool(STRAVA_CLIENT_ID),
            "strava_client_secret_set": bool(STRAVA_CLIENT_SECRET),
            "strava_redirect_uri": STRAVA_REDIRECT_URI,
            "session_has_token": "access_token" in session,
            "db_path": repository.stats().get("db_path"),
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(debug=False, host="0.0.0.0", port=port)
