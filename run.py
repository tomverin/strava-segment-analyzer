#!/usr/bin/env python3
"""
Simple script to run the Strava Segment Analyzer app.
"""

import os
import sys
from pathlib import Path

def main():
    # Check if .env file exists
    if not Path('.env').exists():
        print("❌ Error: .env file not found!")
        print("📝 Please copy .env.example to .env and fill in your Strava API credentials:")
        print("   cp .env.example .env")
        print("   # Then edit .env with your actual Strava Client ID and Secret")
        sys.exit(1)
    
    # Check if environment variables are set
    from dotenv import load_dotenv
    load_dotenv()
    
    if not os.getenv('STRAVA_CLIENT_ID') or os.getenv('STRAVA_CLIENT_ID') == 'your_strava_client_id_here':
        print("❌ Error: STRAVA_CLIENT_ID not set in .env file!")
        print("📝 Please edit .env and add your actual Strava API credentials")
        sys.exit(1)
    
    if not os.getenv('STRAVA_CLIENT_SECRET') or os.getenv('STRAVA_CLIENT_SECRET') == 'your_strava_client_secret_here':
        print("❌ Error: STRAVA_CLIENT_SECRET not set in .env file!")
        print("📝 Please edit .env and add your actual Strava API credentials")
        sys.exit(1)
    
    print("🚀 Starting Strava Segment Analyzer...")
    print("📱 Visit http://localhost:8000 in your browser")
    print("🛑 Press Ctrl+C to stop the server")
    print()
    
    # Import and run the app
    from app import app
    app.run(debug=True, host='0.0.0.0', port=8000)

if __name__ == '__main__':
    main() 