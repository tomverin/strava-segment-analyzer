# Strava Segment Analyzer

A Flask web app that authenticates with Strava, batch-downloads all efforts for a segment, stores them in SQLite, and lets you sort/filter them in the existing UI.

## What Changed

The backend now uses a database-backed sync flow instead of file cache + per-request enrichment.

- First load of a segment triggers a full sync:
  - segment metadata
  - all segment efforts (paginated)
  - related activities for your athlete
- Data is stored in `data/strava.db`
- Subsequent loads read from SQLite
- You can force refresh with `?refresh=true` or the sync endpoint

## Features

- Strava OAuth login
- Batch sync for a specific segment
- SQLite persistence for segments, activities, and efforts
- Existing sorting/filtering UI retained
- Metrics shown in UI: elapsed time, moving time, distance, HR, power, VAM

## Requirements

- Python 3.8+
- A Strava API application

## Setup

### 1. Create Strava API app

1. Go to https://www.strava.com/settings/api
2. Create an application
3. Set callback domain to `localhost`
4. Save your `Client ID` and `Client Secret`

### 2. Configure environment

Create `.env` (or copy `.env.example`) and set:

```env
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
STRAVA_REDIRECT_URI=http://localhost:8000/auth/callback
SECRET_KEY=any_random_secret
# Optional
# STRAVA_DB_PATH=data/strava.db
```

### 3. Install dependencies

With Poetry:

```bash
poetry install
```

Or with pip:

```bash
pip install -r requirements.txt
```

### 4. Run app

```bash
poetry run python app.py
```

Open `http://localhost:8000`.

## How To Use

1. Login with Strava
2. Open a segment page: `/segment/<segment_id>`
3. On first load, backend performs batch sync and stores data
4. Use UI filters/sorting as before

Example:

- Segment URL in Strava: `https://www.strava.com/segments/12345`
- App URL: `http://localhost:8000/segment/12345`

## Sync and Data Endpoints

- `GET /segment/<segment_id>/efforts`
  - Returns stored efforts for your athlete
  - If missing, performs initial batch sync
- `GET /segment/<segment_id>/efforts?refresh=true`
  - Forces a new full sync before returning data
- `POST /segment/<segment_id>/sync`
  - Triggers sync manually
  - Returns `{ "message": "Sync completed", "effort_count": N }`

## Storage

- SQLite DB path: `data/strava.db` (default)
- DB file is git-ignored
- "Clear cache" in UI now clears persisted DB data via backend endpoint

## Auth Scope

This app requests:

- `read`
- `activity:read_all`

## Tech Stack

- Backend: Flask + requests + SQLite
- Frontend: existing HTML/CSS/JS UI
- Auth: Strava OAuth 2.0
