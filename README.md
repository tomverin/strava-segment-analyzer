# Strava Segment Analyzer

A web application that connects to Strava and analyzes your efforts on specific segments, with filtering capabilities for heart rate and date ranges.

## Features

- **Strava OAuth Integration**: Secure authentication with Strava
- **Segment Effort Analysis**: Fetch all your efforts for any segment
- **Segment-Specific Heart Rate**: Uses Strava's pre-calculated segment effort heart rate data
- **Heart Rate Filtering**: Filter efforts by average heart rate range
- **Power Filtering**: Filter efforts by average power range
- **Date Range Filtering**: Filter efforts by date range
- **Interactive Interface**: Modern, responsive web interface
- **Detailed Metrics**: View elapsed time, moving time, distance, heart rate, power, and VAM data
- **VAM Calculation**: Vertical Ascent Meters per hour for climbing performance analysis
- **Segment History**: Quick access to recently viewed segments with persistent storage
- **Smart Caching**: Intelligent API caching to minimize rate limits and improve performance
- **Instant Loading**: Cache-first loading strategy for near-instant page rendering
- **Rate Limit Protection**: Automatic fallback modes and request throttling

## Setup

### 1. Strava API Setup

1. Go to [Strava API Settings](https://www.strava.com/settings/api)
2. Create a new application
3. Note your Client ID and Client Secret
4. Set the Authorization Callback Domain to `localhost`

### 2. Environment Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in your Strava API credentials in `.env`:
   ```
   STRAVA_CLIENT_ID=your_actual_client_id
   STRAVA_CLIENT_SECRET=your_actual_client_secret
   STRAVA_REDIRECT_URI=http://localhost:8000/auth/callback
   SECRET_KEY=your_random_secret_key
   ```

### 3. Installation

1. Install dependencies and create virtual environment with Poetry:
   ```bash
   poetry install
   ```

2. Run the application:
   ```bash
   # Option 1: Using the run script (recommended - includes error checking)
   poetry run python run.py
   
   # Option 2: Direct app run
   poetry run python app.py
   
   # Option 3: Activate Poetry shell first, then run normally
   poetry shell
   python app.py
   ```

### 4. Run the Application

```bash
# Recommended: Use the run script (includes validation)
poetry run python run.py

# Alternative: Run Flask app directly
poetry run python app.py
```

Visit `http://localhost:8000` in your browser.

## Usage

1. **Login**: Click login to authenticate with Strava
2. **Analyze Segment**: Navigate to `/segment/{segment_id}` where `segment_id` is the Strava segment ID
3. **Filter Efforts**: Use the heart rate and date range filters to analyze your performance
4. **View Details**: Click on individual efforts to see detailed information
5. **Quick Navigation**: Use recent segments history for fast access to previously analyzed segments
6. **Monitor Cache**: View cache statistics and clear expired entries to manage API usage

## Caching System

The app includes an intelligent caching system to minimize Strava API calls:

### **Cache Types & Duration:**
- **Segments**: 24 hours (segments rarely change)
- **Activities**: 7 days (activities never change once created)
- **Activity Streams**: 7 days (heart rate data never changes)
- **Segment Efforts**: 1 hour (new efforts can be added)

### **API Usage Reduction:**
- **First Load**: Full API calls required (segment + efforts + activities + streams)
- **Subsequent Loads**: Only cache hits, dramatically reduced API usage
- **Example**: 20 efforts = ~41 API calls initially, then ~1 call for 1 hour

### **Rate Limit Protection:**
- **Automatic throttling**: 500ms delays between requests
- **Fallback mode**: Uses activity-level heart rate if streams unavailable
- **Smart retry**: Automatic fallback with user notification

### **Instant Loading System:**
- **Cache-first loading**: Shows cached data immediately while refreshing in background
- **Dual-layer caching**: Server-side (Flask) + Client-side (localStorage) caching
- **Progressive enhancement**: Fresh data replaces cached data seamlessly
- **Visual feedback**: Refresh indicators and notifications for cache status

## Finding Segment IDs

You can find segment IDs from Strava URLs:
- Segment URL: `https://www.strava.com/segments/12345`
- Segment ID: `12345`

## API Rate Limits & Efficiency

### **Strava API Limits:**
- **15-minute limit**: 200 requests
- **Daily limit**: 2,000 requests

### **App Efficiency:**
- **Without caching**: ~41 API calls per 20 efforts (unsustainable)
- **With caching**: ~1-5 API calls per subsequent load (sustainable)
- **Cache hit ratio**: >95% after initial loads

## API Scope

This app requests the following Strava scopes:
- `read`: Read public profile information
- `activity:read_all`: Read all activity data including private activities and streams

## Technologies Used

- **Backend**: Flask (Python)
- **Frontend**: HTML, CSS, JavaScript
- **API**: Strava API v3
- **Authentication**: OAuth 2.0
- **Dependency Management**: Poetry
- **Package Management**: Homebrew 