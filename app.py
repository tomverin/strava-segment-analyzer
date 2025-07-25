from flask import Flask, render_template, request, redirect, url_for, session, jsonify
import os
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv
import json
import time
from cache_manager import cache

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', 'your-secret-key-here')

# Strava API configuration
STRAVA_CLIENT_ID = os.getenv('STRAVA_CLIENT_ID')
STRAVA_CLIENT_SECRET = os.getenv('STRAVA_CLIENT_SECRET')
STRAVA_REDIRECT_URI = os.getenv('STRAVA_REDIRECT_URI', 'http://localhost:8000/auth/callback')

# Strava API endpoints
STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize'
STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'
STRAVA_API_BASE = 'https://www.strava.com/api/v3'

@app.route('/')
def index():
    """Main page - check if user is authenticated"""
    if 'access_token' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')

@app.route('/login')
def login():
    """Redirect to Strava OAuth login"""
    auth_url = f"{STRAVA_AUTH_URL}?client_id={STRAVA_CLIENT_ID}&response_type=code&redirect_uri={STRAVA_REDIRECT_URI}&approval_prompt=force&scope=read,activity:read_all"
    return redirect(auth_url)

@app.route('/auth/callback')
def auth_callback():
    """Handle Strava OAuth callback"""
    code = request.args.get('code')
    if not code:
        return "Authorization failed", 400
    
    # Exchange code for access token
    token_data = {
        'client_id': STRAVA_CLIENT_ID,
        'client_secret': STRAVA_CLIENT_SECRET,
        'code': code,
        'grant_type': 'authorization_code'
    }
    
    response = requests.post(STRAVA_TOKEN_URL, data=token_data)
    if response.status_code == 200:
        token_info = response.json()
        session['access_token'] = token_info['access_token']
        session['refresh_token'] = token_info['refresh_token']
        session['athlete_id'] = token_info['athlete']['id']
        return redirect(url_for('index'))
    else:
        return "Token exchange failed", 400

@app.route('/logout')
def logout():
    """Clear session and logout"""
    session.clear()
    return redirect(url_for('login'))

@app.route('/segment/<int:segment_id>/efforts')
def get_segment_efforts(segment_id):
    """Get all efforts for a specific segment"""
    if 'access_token' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    
    access_token = session['access_token']
    athlete_id = session['athlete_id']
    
    # Check for fallback mode (skip heart rate streams to avoid rate limits)
    fallback_mode = request.args.get('fallback', 'false').lower() == 'true'
    
    # Get segment info for VAM calculation
    segment_info = cache.get('segment', str(segment_id))
    if segment_info is None:
        headers = {'Authorization': f'Bearer {access_token}'}
        segment_url = f"{STRAVA_API_BASE}/segments/{segment_id}"
        segment_response = requests.get(segment_url, headers=headers)
        if segment_response.status_code == 200:
            segment_info = segment_response.json()
            cache.set('segment', str(segment_id), segment_info)
        else:
            return jsonify({'error': 'Failed to fetch segment info'}), 400
    
    # Check cache for segment efforts first (shorter TTL as new efforts can be added)
    efforts_cache_key = f"{segment_id}_{athlete_id}"
    efforts = cache.get('efforts', efforts_cache_key)
    
    if efforts is None:
        # Get segment efforts from API
        efforts_url = f"{STRAVA_API_BASE}/segment_efforts"
        headers = {'Authorization': f'Bearer {access_token}'}
        params = {
            'segment_id': segment_id,
            'athlete_id': athlete_id,
            'per_page': 200  # Maximum allowed
        }
        
        response = requests.get(efforts_url, headers=headers, params=params)
        if response.status_code != 200:
            return jsonify({'error': 'Failed to fetch efforts'}), 400
        
        efforts = response.json()
        # Cache efforts for 1 hour (new efforts might be added)
        cache.set('efforts', efforts_cache_key, efforts)
    
    headers = {'Authorization': f'Bearer {access_token}'}
    
    # Get detailed activity data for each effort to include heart rate
    detailed_efforts = []
    for i, effort in enumerate(efforts):
        # Add delay between requests to avoid rate limiting
        if i > 0:
            time.sleep(0.5)  # 500ms delay between requests
            
        activity_id = effort['activity']['id']
        
        # Check cache for activity data first
        activity_data = cache.get('activity', str(activity_id))
        
        if activity_data is None:
            activity_url = f"{STRAVA_API_BASE}/activities/{activity_id}"
            activity_response = requests.get(activity_url, headers=headers)
            
            if activity_response.status_code == 200:
                activity_data = activity_response.json()
                # Cache activity data for 7 days (activities don't change)
                cache.set('activity', str(activity_id), activity_data)
            elif activity_response.status_code == 429:
                # Rate limit hit - return what we have so far
                print(f"Rate limit hit after processing {i} efforts")
                break
            else:
                continue  # Skip this effort if we can't get activity data
        
        if activity_data:
            
            # Get segment-specific heart rate data
            # First try to use the heart rate data directly from the segment effort
            effort_avg_hr = effort.get('average_heartrate')
            effort_max_hr = effort.get('max_heartrate')
            
            if effort_avg_hr is not None and effort_max_hr is not None:
                # Use the segment effort's heart rate data (most accurate)
                segment_hr_data = {
                    'average_heartrate': effort_avg_hr,
                    'max_heartrate': effort_max_hr
                }
            elif not fallback_mode:
                # Try to calculate from streams using start/end indices
                segment_hr_data = get_segment_heart_rate_from_streams(activity_id, effort, headers)
            else:
                # Fallback to activity-level heart rate
                segment_hr_data = {
                    'average_heartrate': activity_data.get('average_heartrate'),
                    'max_heartrate': activity_data.get('max_heartrate')
                }
            
            # Calculate VAM (Vertical Ascent Meters per hour)
            vam = None
            elevation_gain = segment_info.get('total_elevation_gain', 0)
            elapsed_time = effort.get('elapsed_time', 0)
            if elevation_gain and elapsed_time:
                # VAM = (elevation gain in meters / time in seconds) * 3600 (to get meters/hour)
                vam = round((elevation_gain / elapsed_time) * 3600, 0)
            
            # Get average power from effort
            average_watts = effort.get('average_watts')
            
            effort_detail = {
                'id': effort['id'],
                'start_date': effort['start_date'],
                'elapsed_time': effort['elapsed_time'],
                'moving_time': effort.get('moving_time', effort['elapsed_time']),
                'distance': effort.get('distance', 0),
                'average_heartrate': segment_hr_data['average_heartrate'],
                'max_heartrate': segment_hr_data['max_heartrate'],
                'average_watts': average_watts,
                'vam': vam,
                'name': activity_data.get('name', 'Untitled'),
                'activity_id': activity_id
            }
            detailed_efforts.append(effort_detail)

    
    return jsonify(detailed_efforts)

def get_segment_heart_rate_from_streams(activity_id, effort, headers):
    """Get heart rate data specific to the segment effort"""
    try:
        # Check cache for streams data first
        streams_data = cache.get('streams', str(activity_id))
        
        if streams_data is None:
            # Add small delay before streams request
            time.sleep(0.3)
            
            # Get activity streams (heart rate and time data)
            streams_url = f"{STRAVA_API_BASE}/activities/{activity_id}/streams"
            params = {
                'keys': 'heartrate,time',
                'key_by_type': 'true'
            }
            
            streams_response = requests.get(streams_url, headers=headers, params=params)
            if streams_response.status_code == 429:
                print(f"Rate limit hit getting streams for activity {activity_id}")
                return {'average_heartrate': None, 'max_heartrate': None}
            elif streams_response.status_code != 200:
                return {'average_heartrate': None, 'max_heartrate': None}
            
            streams_data = streams_response.json()
            # Cache streams data for 7 days (heart rate data doesn't change)
            cache.set('streams', str(activity_id), streams_data)
        
        # Check if heart rate data is available
        if 'heartrate' not in streams_data or 'time' not in streams_data:
            return {'average_heartrate': None, 'max_heartrate': None}
        
        heartrate_stream = streams_data['heartrate']['data']
        time_stream = streams_data['time']['data']
        
        # Parse effort start time and calculate segment window
        from datetime import datetime
        
        # Use start_index and end_index if available (more accurate than time-based calculation)
        start_index = effort.get('start_index')
        end_index = effort.get('end_index')
        
        if start_index is not None and end_index is not None:
            # Use indices to extract segment-specific heart rate data
            try:
                segment_hr_values = []
                for i in range(start_index, min(end_index + 1, len(heartrate_stream))):
                    if i < len(heartrate_stream) and heartrate_stream[i] is not None:
                        segment_hr_values.append(heartrate_stream[i])
                
                if segment_hr_values:
                    avg_hr = sum(segment_hr_values) / len(segment_hr_values)
                    max_hr = max(segment_hr_values)
                    return {
                        'average_heartrate': round(avg_hr, 1),
                        'max_heartrate': max_hr
                    }
                else:
                    return {'average_heartrate': None, 'max_heartrate': None}
                    
            except (ValueError, TypeError) as e:
                print(f"Error using stream indices {start_index}-{end_index}: {e}")
                return {'average_heartrate': None, 'max_heartrate': None}
        else:
            print(f"No start_index/end_index found for effort in activity {activity_id}")
            return {'average_heartrate': None, 'max_heartrate': None}
            
    except Exception as e:
        print(f"Error getting segment heart rate: {e}")
        return {'average_heartrate': None, 'max_heartrate': None}

@app.route('/segment/<int:segment_id>')
def segment_analyzer(segment_id):
    """Show segment analyzer page"""
    if 'access_token' not in session:
        return redirect(url_for('login'))
    
    # Check cache first
    segment_info = cache.get('segment', str(segment_id))
    
    if segment_info is None:
        # Get segment info from API
        access_token = session['access_token']
        headers = {'Authorization': f'Bearer {access_token}'}
        segment_url = f"{STRAVA_API_BASE}/segments/{segment_id}"
        
        response = requests.get(segment_url, headers=headers)
        if response.status_code != 200:
            print(f"Segment API Error: {response.status_code}, {response.text}")
            return f"Segment not found - Status: {response.status_code}, Error: {response.text}", 404
        
        segment_info = response.json()
        # Cache segment info for 24 hours
        cache.set('segment', str(segment_id), segment_info)
    
    return render_template('segment_analyzer.html', segment=segment_info)

@app.route('/cache/stats')
def cache_stats():
    """Get cache statistics"""
    if 'access_token' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    
    stats = cache.get_cache_stats()
    return jsonify(stats)

@app.route('/cache/clear', methods=['POST'])
def clear_cache():
    """Clear expired cache entries"""
    if 'access_token' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    
    cache.clear_expired()
    return jsonify({'message': 'Expired cache entries cleared'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(debug=False, host='0.0.0.0', port=port) 