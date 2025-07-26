import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

class StravaCache:
    """File-based cache for Strava API data with no expiration"""
    
    def __init__(self, cache_dir="cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
    
    def _get_cache_path(self, cache_type, key):
        """Get the file path for a cache entry"""
        filename = f"{cache_type}_{key}.json"
        return self.cache_dir / filename
    
    def get(self, cache_type, key):
        """Get data from cache if exists"""
        try:
            cache_path = self._get_cache_path(cache_type, key)
            if not cache_path.exists():
                return None
            
            with open(cache_path, 'r') as f:
                cache_data = json.load(f)
            
            return cache_data['data']
        
        except (json.JSONDecodeError, KeyError, OSError):
            # If any error reading cache, treat as cache miss
            return None
    
    def set(self, cache_type, key, data):
        """Store data in cache with timestamp"""
        try:
            cache_path = self._get_cache_path(cache_type, key)
            cache_data = {
                'timestamp': time.time(),
                'data': data
            }
            
            with open(cache_path, 'w') as f:
                json.dump(cache_data, f, indent=2)
        
        except OSError:
            # If we can't write to cache, just continue without caching
            pass
    
    def delete(self, cache_type, key):
        """Delete a cache entry"""
        try:
            cache_path = self._get_cache_path(cache_type, key)
            if cache_path.exists():
                cache_path.unlink()
        except OSError:
            pass
    
    def clear_all(self):
        """Clear all cache entries"""
        try:
            for cache_file in self.cache_dir.glob("*.json"):
                try:
                    cache_file.unlink()
                except OSError:
                    pass
        except OSError:
            pass
    
    def get_cache_stats(self):
        """Get cache statistics"""
        stats = {
            'total_files': 0,
            'by_type': {},
            'total_size': 0,
            'oldest_entry': None,
            'newest_entry': None
        }
        
        try:
            oldest_time = float('inf')
            newest_time = 0
            
            for cache_file in self.cache_dir.glob("*.json"):
                stats['total_files'] += 1
                stats['total_size'] += cache_file.stat().st_size
                
                # Extract cache type from filename
                cache_type = cache_file.stem.split('_')[0]
                stats['by_type'][cache_type] = stats['by_type'].get(cache_type, 0) + 1
                
                try:
                    with open(cache_file, 'r') as f:
                        data = json.load(f)
                        timestamp = data.get('timestamp', 0)
                        if timestamp < oldest_time:
                            oldest_time = timestamp
                            stats['oldest_entry'] = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
                        if timestamp > newest_time:
                            newest_time = timestamp
                            stats['newest_entry'] = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
                except (json.JSONDecodeError, KeyError, OSError):
                    pass
        
        except OSError:
            pass
        
        return stats

# Global cache instance
cache = StravaCache() 